import { Inject, Injectable } from '@nestjs/common';
import { FeatureFlag, SystemConfigCore } from 'src/cores/system-config.core';
import { AssetResponseDto, mapAsset } from 'src/dtos/asset-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { PersonResponseDto } from 'src/dtos/person.dto';
import {
  MetadataSearchDto,
  PlacesResponseDto,
  SearchPeopleDto,
  SearchPlacesDto,
  SearchResponseDto,
  SearchSuggestionRequestDto,
  SearchSuggestionType,
  SmartSearchDto,
  mapPlaces,
} from 'src/dtos/search.dto';
import { AssetOrder } from 'src/entities/album.entity';
import { AssetEntity } from 'src/entities/asset.entity';
import { AssetOrderPreference } from 'src/entities/user.entity';
import { IAssetRepository } from 'src/interfaces/asset.interface';
import { ILoggerRepository } from 'src/interfaces/logger.interface';
import { IMachineLearningRepository } from 'src/interfaces/machine-learning.interface';
import { IMetadataRepository } from 'src/interfaces/metadata.interface';
import { IPartnerRepository } from 'src/interfaces/partner.interface';
import { IPersonRepository } from 'src/interfaces/person.interface';
import { ISearchRepository, SearchExploreItem } from 'src/interfaces/search.interface';
import { ISystemConfigRepository } from 'src/interfaces/system-config.interface';

@Injectable()
export class SearchService {
  private configCore: SystemConfigCore;

  constructor(
    @Inject(ISystemConfigRepository) configRepository: ISystemConfigRepository,
    @Inject(IMachineLearningRepository) private machineLearning: IMachineLearningRepository,
    @Inject(IPersonRepository) private personRepository: IPersonRepository,
    @Inject(ISearchRepository) private searchRepository: ISearchRepository,
    @Inject(IAssetRepository) private assetRepository: IAssetRepository,
    @Inject(IPartnerRepository) private partnerRepository: IPartnerRepository,
    @Inject(IMetadataRepository) private metadataRepository: IMetadataRepository,
    @Inject(ILoggerRepository) private logger: ILoggerRepository,
  ) {
    this.logger.setContext(SearchService.name);
    this.configCore = SystemConfigCore.create(configRepository, logger);
  }

  async searchPerson(auth: AuthDto, dto: SearchPeopleDto): Promise<PersonResponseDto[]> {
    return this.personRepository.getByName(auth.user.id, dto.name, { withHidden: dto.withHidden });
  }

  async searchPlaces(dto: SearchPlacesDto): Promise<PlacesResponseDto[]> {
    const places = await this.searchRepository.searchPlaces(dto.name);
    return places.map((place) => mapPlaces(place));
  }

  async getExploreData(auth: AuthDto): Promise<SearchExploreItem<AssetResponseDto>[]> {
    await this.configCore.requireFeature(FeatureFlag.SEARCH);
    const options = { maxFields: 12, minAssetsPerField: 5 };
    const results = await Promise.all([
      this.assetRepository.getAssetIdByCity(auth.user.id, options),
      this.assetRepository.getAssetIdByTag(auth.user.id, options),
    ]);
    const assetIds = new Set<string>(results.flatMap((field) => field.items.map((item) => item.data)));
    const assets = await this.assetRepository.getByIdsWithAllRelations([...assetIds]);
    const assetMap = new Map<string, AssetResponseDto>(assets.map((asset) => [asset.id, mapAsset(asset)]));

    return results.map(({ fieldName, items }) => ({
      fieldName,
      items: items.map(({ value, data }) => ({ value, data: assetMap.get(data) as AssetResponseDto })),
    }));
  }

  async searchMetadata(auth: AuthDto, dto: MetadataSearchDto): Promise<SearchResponseDto> {
    let checksum: Buffer | undefined;
    const userIds = await this.getUserIdsToSearch(auth);

    if (dto.checksum) {
      const encoding = dto.checksum.length === 28 ? 'base64' : 'hex';
      checksum = Buffer.from(dto.checksum, encoding);
    }

    dto.previewPath ??= dto.resizePath;
    dto.thumbnailPath ??= dto.webpPath;

    const page = dto.page ?? 1;
    const size = dto.size || 250;

    const enumToOrder = { [AssetOrderPreference.ASC]: 'ASC', [AssetOrderPreference.DESC]: 'DESC' } as const;

    const mapOrder = (order?: AssetOrder) => {
      if (!order) {
        return enumToOrder[AssetOrderPreference.DESC];
      }
      if (order === AssetOrder.PREFERENCE) {
        return enumToOrder[auth.user.preferedAlbumOrder];
      }
      return enumToOrder[order];
    };

    const order = mapOrder(dto.order);
    const { hasNextPage, items } = await this.searchRepository.searchMetadata(
      { page, size },
      {
        ...dto,
        checksum,
        userIds,
        orderDirection: order,
      },
    );

    return this.mapResponse(items, hasNextPage ? (page + 1).toString() : null);
  }

  async searchSmart(auth: AuthDto, dto: SmartSearchDto): Promise<SearchResponseDto> {
    await this.configCore.requireFeature(FeatureFlag.SMART_SEARCH);
    const { machineLearning } = await this.configCore.getConfig();
    const userIds = await this.getUserIdsToSearch(auth);

    const embedding = await this.machineLearning.encodeText(
      machineLearning.url,
      { text: dto.query },
      machineLearning.clip,
    );

    const page = dto.page ?? 1;
    const size = dto.size || 100;
    const { hasNextPage, items } = await this.searchRepository.searchSmart(
      { page, size },
      { ...dto, userIds, embedding },
    );

    return this.mapResponse(items, hasNextPage ? (page + 1).toString() : null);
  }

  async getAssetsByCity(auth: AuthDto): Promise<AssetResponseDto[]> {
    const userIds = await this.getUserIdsToSearch(auth);
    const assets = await this.searchRepository.getAssetsByCity(userIds);
    return assets.map((asset) => mapAsset(asset));
  }

  getSearchSuggestions(auth: AuthDto, dto: SearchSuggestionRequestDto): Promise<string[]> {
    switch (dto.type) {
      case SearchSuggestionType.COUNTRY: {
        return this.metadataRepository.getCountries(auth.user.id);
      }
      case SearchSuggestionType.STATE: {
        return this.metadataRepository.getStates(auth.user.id, dto.country);
      }
      case SearchSuggestionType.CITY: {
        return this.metadataRepository.getCities(auth.user.id, dto.country, dto.state);
      }
      case SearchSuggestionType.CAMERA_MAKE: {
        return this.metadataRepository.getCameraMakes(auth.user.id, dto.model);
      }
      case SearchSuggestionType.CAMERA_MODEL: {
        return this.metadataRepository.getCameraModels(auth.user.id, dto.make);
      }
    }
  }

  private async getUserIdsToSearch(auth: AuthDto): Promise<string[]> {
    const userIds: string[] = [auth.user.id];
    const partners = await this.partnerRepository.getAll(auth.user.id);
    const partnersIds = partners
      .filter((partner) => partner.sharedBy && partner.inTimeline)
      .map((partner) => partner.sharedById);
    userIds.push(...partnersIds);
    return userIds;
  }

  private mapResponse(assets: AssetEntity[], nextPage: string | null): SearchResponseDto {
    return {
      albums: { total: 0, count: 0, items: [], facets: [] },
      assets: {
        total: assets.length,
        count: assets.length,
        items: assets.map((asset) => mapAsset(asset)),
        facets: [],
        nextPage,
      },
    };
  }
}
