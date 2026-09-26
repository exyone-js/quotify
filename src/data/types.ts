/** 单条一言。 */
export interface Epigram {
  id: string;
  content: string;
  source?: string;
  author?: string;
  category?: string;
  tags?: string[];
}

/** GitHub 仓库 `epigram-data/data.json` 的完整结构。 */
export interface EpigramDataset {
  version: number;
  updated_at: string;
  epigrams: Epigram[];
}

/** `epigram:meta:v1` 中保存的缓存元信息。 */
export interface DatasetMeta {
  loaded_at: number;
  source_url: string;
  etag?: string;
}
