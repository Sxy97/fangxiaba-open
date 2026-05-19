export interface UrlList {
  url_list?: string[];
  uri?: string;
}

export interface AwemeVideo {
  cover: { url_list: string[]; width?: number; height?: number };
  play_addr?: UrlList;
  play_addr_h264?: UrlList;
  bit_rate?: Array<{
    play_addr?: UrlList;
    bit_rate?: number;
  }>;
}

export interface Aweme {
  aweme_id: string;
  desc: string;
  aweme_type: number;
  video: AwemeVideo;
  statistics?: {
    digg_count?: number;
  };
  images?: Array<{
    url_list?: string[];
    download_url_list?: string[];
  }>;
  image_infos?: Array<{
    label_large?: UrlList;
    label_thumb?: UrlList;
    origin_image?: UrlList;
  }>;
}

export interface PostApiResponse {
  aweme_list: Aweme[];
  max_cursor: number;
  has_more: boolean;
}

export interface FetchOptions {
  count?: number;
}

export interface UserInfo {
  nickname: string;
  avatar: string;
  uniqueId: string;
  awemeCount: number;
  signature: string;
  followingCount: number;
  followerCount: number;
  totalFavorited: string | number;
}

export interface UserResult extends UserInfo {
  secUid: string;
  videos: Aweme[];
  requestedCount: number;
  returnedCount: number;
  hasMore: boolean;
}

export interface CommentAuthor {
  nickname: string;
  avatar: string;
  uniqueId: string;
  shortId: string;
  secUid: string;
  signature: string;
}

export interface PublicComment {
  cid: string;
  text: string;
  createTime: number;
  diggCount: number;
  user: CommentAuthor;
}

export interface CommentResult {
  comments: PublicComment[];
  hasMore: boolean;
  cursor: number;
}
