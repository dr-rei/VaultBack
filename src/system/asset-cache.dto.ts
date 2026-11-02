import { IsBoolean, IsInt, Max, Min } from 'class-validator';

export class AssetCacheSettingsDto {
  @IsBoolean()
  enabled!: boolean;

  @IsInt()
  @Min(60)
  @Max(31536000)
  browserMaxAgeSeconds!: number;

  @IsInt()
  @Min(60)
  @Max(31536000)
  edgeMaxAgeSeconds!: number;
}
