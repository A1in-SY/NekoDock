/** Independent classifier for unsolicited group replies; never the chat agent. */
export interface ReplyDecisionConfig {
  mode: 'random' | 'jev';
  baseUrl: string;
  model: string;
  apiKey?: string;
  threshold: number;
  timeoutMs: number;
  instructions: string;
}
