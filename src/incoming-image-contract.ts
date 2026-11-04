/** Stable, instance-scoped references. Download credentials never cross this boundary. */
export const INCOMING_IMAGE_MAX_COUNT = 64;

export interface IncomingImageDescriptor {
  id: string;
  messageId: string;
  index: number;
  /** Stable position inside the real outer message, including nested forwarded records. */
  sourceKey?: string;
  status: 'pending' | 'ready' | 'failed' | 'expired' | 'transferred';
  sha256?: string;
  mimeType?: string;
  size?: number;
  error?: string;
}

export interface IncomingImageRemote {
  list(signal: AbortSignal): Promise<IncomingImageDescriptor[]>;
  get(id: string, signal: AbortSignal): Promise<IncomingImageDescriptor>;
  content(id: string, signal: AbortSignal): Promise<Buffer>;
  acknowledge(id: string, sha256: string | undefined, signal: AbortSignal): Promise<void>;
}

export interface CachedIncomingImage {
  attachmentId: string;
  sourceKey?: string;
  status: 'pending' | 'ready' | 'failed' | 'expired';
  path?: string;
  error?: string;
  origin?: 'plugin';
  pluginId?: string;
  assetId?: string;
}

export interface PreparedIncomingImages {
  files: string[];
  byMessageId: Map<string, CachedIncomingImage[]>;
}
