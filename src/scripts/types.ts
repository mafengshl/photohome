// 客户端使用的类型定义

/** 一张照片（与 /api/getPhotos 返回结构对齐） */
export interface Photo {
  /** 唯一 id，使用飞书记录 id，便于去重 */
  id: string;
  /** 标题 */
  title?: string;
  /** 描述 */
  desc?: string;
  /** 拍摄时间（毫秒时间戳，0 表示缺失） */
  photoTime?: number;
  /** 排序序号（越小越靠前，0 表示未设置） */
  sortOrder?: number;
  /** 可直接访问的图片 URL（由后端把飞书临时链接转换为公网临时 URL） */
  url: string;
  /** 原图宽度（可能为 0，未知时由前端在加载后读取） */
  width: number;
  /** 原图高度 */
  height: number;
  /** MIME 类型，用于决定加载提示 */
  type?: string;
}

/** /api/getPhotos 的响应 */
export interface PhotosResponse {
  photos: Photo[];
  /** 总数 */
  total: number;
  /** 当前页码（1-based） */
  page: number;
  /** 每页条数 */
  pageSize: number;
  /** 是否还有下一页 */
  hasMore: boolean;
}

/** 布局度量（与 global.css 中的 CSS 变量保持一致） */
export interface GridMetrics {
  cellMin: number;
  rowUnit: number;
  gap: number;
}

/** 卡片形态：text 纯留言，mini 竖图，square 方图，wide 横图 */
export type CardType = 'text' | 'mini' | 'square' | 'wide';

/** 3D 宇宙中展示的一条消息（由 Photo 映射而来） */
export interface Message {
  /** 唯一 id */
  id: string;
  /** 昵称（卡片正面 caption） */
  author: string;
  /** 留言内容（卡片背面） */
  content: string;
  /** 展示日期 YYYY-MM-DD */
  date: string;
  /** 原始 ISO 时间，用于排序 */
  timestamp?: string;
  /** 排序序号（越小越靠前，0 表示未设置） */
  sortOrder?: number;
  /** 图片地址（snake_case，兼容目标站字段名） */
  image_url?: string;
  /** 图片地址（camelCase 别名，渲染时实际读取） */
  imageUrl?: string;
  /** 是否为图片卡 */
  hasImage: boolean;
  /** 卡片形态 */
  format_type: CardType;
  /** 原图宽度（缺失时默认 1000，图片加载后按 naturalWidth 修正） */
  width?: number;
  /** 原图高度 */
  height?: number;
}
