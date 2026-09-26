/** 单条引语（公开 API 中即一个 quote 资源）。 */
export interface Quote {
  id: string;
  content: string;
  source?: string;
  author?: string;
  category?: string;
  tags?: string[];
}

/** GitHub 仓库 `epigram-data/data.json` 的完整结构。 */
export interface QuoteDataset {
  version: number;
  updated_at: string;
  quotes: Quote[];
}

/** `epigram:meta:v2` 中保存的缓存元信息。 */
export interface DatasetMeta {
  loaded_at: number;
  source_url: string;
  etag?: string;
}
