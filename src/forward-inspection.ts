import { randomInt } from 'node:crypto';

export interface ForwardInspectionSample {
  sourceKey: string;
  source?: string;
  attachmentId?: string;
}

export interface ForwardInspectionSummary {
  structuralComplete: boolean;
  messageCount: number;
  imageMessageCount: number;
  imageCount: number;
  samples: ForwardInspectionSample[];
}

/** Observations contain private source locations and must not be published as chat content. */
export interface ForwardObserver {
  message(path: string, hasImage: boolean): void;
  image(sourceKey: string, source: string | undefined, attachmentId?: string): void;
  incomplete(reason: string): void;
}

/** Uniform sampling over image occurrences, including those outside the chat attachment limit. */
export class ForwardInspectionCollector implements ForwardObserver {
  private readonly value: ForwardInspectionSummary = { structuralComplete: true, messageCount: 0, imageMessageCount: 0, imageCount: 0, samples: [] };
  constructor(private readonly maxImages: number, private readonly options: {
    randomInt?: (maximum: number) => number;
    sample?: (added: ForwardInspectionSample, removed?: ForwardInspectionSample) => void;
  } = {}) {
    if (!Number.isSafeInteger(maxImages) || maxImages < 1 || maxImages > 16) throw new Error('Invalid inspection image limit.');
  }
  message(_path: string, hasImage: boolean): void {
    this.value.messageCount++;
    if (hasImage) this.value.imageMessageCount++;
  }
  image(sourceKey: string, source: string | undefined, attachmentId?: string): void {
    this.value.imageCount++;
    const position = this.value.samples.length < this.maxImages ? this.value.samples.length
      : (this.options.randomInt ?? randomInt)(this.value.imageCount);
    if (position >= this.maxImages) return;
    const added: ForwardInspectionSample = { sourceKey, ...(source ? { source } : {}), ...(attachmentId ? { attachmentId } : {}) };
    const removed = this.value.samples[position];
    this.options.sample?.(added, removed);
    this.value.samples[position] = added;
  }
  incomplete(_reason: string): void { this.value.structuralComplete = false; }
  summary(): ForwardInspectionSummary { return { ...this.value, samples: this.value.samples.map(sample => ({ ...sample })) }; }
}
