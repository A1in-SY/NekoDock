import { useEffect, useState } from 'react';
import { date, Icon } from './ui';
import { ConversationImage } from './image-preview';
import { forwardImageAttachment, forwardStatusLabel, gameFacts, gamePrices, gameScore, incomingImageUrl, liveStatusLabels, pluginAssetUrl, pluginMediaAssetId, sharedContentKind, sharedContentLink, sharedContentPlatform, sharedContentTime, sharedImageCaption } from './shared-content-state';
import { FORWARD_LIMITS } from '../../src/forward-contract';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';

export function IncomingImageAttachment({ image, botId }: { image: unknown; botId: string }) {
  const value = object(image), src = incomingImageUrl(botId, image);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => setUnavailable(false), [src, value.status]);
  if (src && !unavailable) return <ConversationImage src={src} alt="收到的图片" onError={() => setUnavailable(true)} />;
  const label = value.status === 'pending' ? '图片保存中' : value.status === 'expired' ? '图片缓存已过期' : '图片暂不可用';
  return <div className="attachment-placeholder" role="status"><Icon name="document" />{label}</div>;
}

function ForwardRecord({ content, botId, images, depth = 1 }: { content: Record<string, unknown>; botId: string; images?: unknown; depth?: number }) {
  const nodes = Array.isArray(content.nodes) ? content.nodes.slice(0, FORWARD_LIMITS.nodes) : [];
  const status = forwardStatusLabel(content.status);
  if (depth > 8) return <p className="forward-content-status">后续层级未展开</p>;
  return <details className="conversation-tool shared-content forward-content">
    <summary><Icon name="chevron" className="chevron" /><Icon name="document" /><span>{depth === 1 ? '聊天记录' : '嵌套聊天记录'}</span>{nodes.length > 0 && <time>{nodes.length} 条</time>}{status && <span className="forward-summary-status">{status}</span>}</summary>
    <div className="forward-content-body">
      {status && <p className="forward-content-status" role="status">{status}{text(content.error) ? ` · ${text(content.error)}` : ''}</p>}
      {nodes.map((entry, index) => {
        const node = object(entry), time = sharedContentTime(node.time);
        const segments = Array.isArray(node.segments) ? node.segments : [];
        return <div className="forward-node" key={text(node.path) || index}>
          <div className="forward-node-author"><strong>{text(node.senderName) || text(node.senderId) || '未提供发言者'}</strong>{time !== undefined && <time>{date(time, { second: '2-digit' })} UTC+8</time>}</div>
          <div className="forward-node-segments">{segments.map((entry, segmentIndex) => {
            const segment = object(entry);
            if (segment.type === 'text') return <span className="forward-node-text" key={segmentIndex}>{text(segment.text)}</span>;
            if (segment.type === 'image') return <div className="forward-node-image" key={segmentIndex}><IncomingImageAttachment image={forwardImageAttachment(segment.assetId, images)} botId={botId} />{text(segment.error) && <p className="forward-content-status">{text(segment.error)}</p>}</div>;
            if (segment.type === 'forward') return <ForwardRecord key={text(segment.path) || segmentIndex} content={segment} botId={botId} images={images} depth={depth + 1} />;
            if (segment.type === 'media') {
              const label: Record<string, string> = { record: '语音', video: '视频', file: '文件', face: '表情', json: '分享卡片', xml: '分享卡片', at: '艾特', reply: '原记录引用' };
              return <span className="forward-node-media" key={segmentIndex}>[{label[text(segment.kind)] || text(segment.kind) || '附件'}{text(segment.name) ? ` · ${text(segment.name)}` : ''}]{text(segment.text) ? ` ${text(segment.text)}` : ''}</span>;
            }
            return null;
          })}</div>
        </div>;
      })}
    </div>
  </details>;
}

export function PluginMediaAttachment({ asset, botId, caption }: { asset: unknown; botId: string; caption?: string }) {
  const value = object(asset), id = pluginMediaAssetId(value);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => setUnavailable(false), [id, value.status]);
  const src = value.status === 'failed' || value.status === 'expired' || value.status === 'pending' ? undefined : pluginAssetUrl(botId, id);
  if (!src || unavailable) return <div className="attachment-placeholder" role="status"><Icon name="document" />{value.status === 'pending' ? '图片准备中' : value.type === 'video' ? '视频不可用或缓存已过期' : '图片不可用或缓存已过期'}</div>;
  if (value.type === 'video') return <video className="plugin-message-media" controls preload="metadata" style={{ maxWidth: '100%', maxHeight: 420, display: 'block' }} src={src} onError={() => setUnavailable(true)} />;
  return <figure className="shared-content-image"><ConversationImage src={src} alt={caption || text(value.title) || '插件图片'} onError={() => setUnavailable(true)} />{caption && <figcaption>{caption}</figcaption>}</figure>;
}

function ContentEmoji({ span, botId }: { span: unknown; botId: string }) {
  const value = object(span), [failed, setFailed] = useState(false), src = pluginAssetUrl(botId, value.assetId);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? <img className="shared-content-emoji" src={src} alt={text(value.text)} loading="lazy" onError={() => setFailed(true)} /> : <>{text(value.text)}</>;
}

function ContentBlocks({ blocks, botId, platform, contentType }: { blocks: unknown[]; botId: string; platform: unknown; contentType: unknown }) {
  return <div className="shared-content-blocks">{blocks.map((entry, index) => {
    const block = object(entry);
    if (block.type === 'paragraph') return <p key={index}>{Array.isArray(block.spans) && block.spans.length ? block.spans.map((span, i) => object(span).type === 'emoji' ? <ContentEmoji key={i} span={span} botId={botId} /> : <span key={i}>{text(object(span).text)}</span>) : text(block.text)}</p>;
    if (block.type === 'image') return <PluginMediaAttachment key={index} asset={object(block.image)} botId={botId} caption={sharedImageCaption(contentType, object(block.image).role)} />;
    if (block.type === 'resource') {
      const resource = object(block.resource), url = sharedContentLink(resource.url, platform);
      return <p key={index}>{url ? <a href={url} target="_blank" rel="noreferrer">{text(block.title) || text(resource.title) || text(resource.id)} <Icon name="arrow" /></a> : text(block.title) || text(resource.title) || text(resource.id)}</p>;
    }
    return null;
  })}</div>;
}

function GameContent({ content }: { content: Record<string, unknown> }) {
  const game = object(content.game), facts = gameFacts(game), score = gameScore(game), prices = gamePrices(game);
  const tags = Array.isArray(game.tags) ? game.tags.slice(0, 20).map(text).filter(Boolean) : [];
  return <section className="shared-game" aria-label="游戏资料">
    {text(game.nameEnglish) && text(game.nameEnglish) !== text(content.title) && <p className="shared-game-name">{text(game.nameEnglish)}</p>}
    {score && <div className="shared-game-score"><span>{score.label}</span><strong>{score.value}</strong>{score.count !== undefined && <small>{score.count.toLocaleString('zh-CN')} 条评价</small>}</div>}
    {facts.length > 0 && <dl className="shared-game-facts">{facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}
    {tags.length > 0 && <div className="shared-game-tags">{tags.map((tag, index) => <span key={index}>{tag}</span>)}</div>}
    {game.isFree === true && <p className="shared-game-free">免费游玩</p>}
    {prices.length > 0 && <div className="shared-game-prices">{prices.map((price, index) => <div className="shared-game-price" key={index}>
      <div className="shared-game-price-heading"><strong>{price.label}</strong><span>{price.source}{price.region ? ` · ${price.region}` : ''}</span></div>
      <div className="shared-game-price-value"><strong>{price.current}</strong>{price.original && <del>{price.original}</del>}{price.discount && <span>{price.discount}</span>}</div>
      {price.condition && <p className="shared-game-price-condition">适用条件：{price.condition}</p>}
      {price.lowest && <p className="shared-game-price-lowest">{price.lowest}</p>}
    </div>)}</div>}
  </section>;
}

function LiveContent({ content, botId }: { content: Record<string, unknown>; botId: string }) {
  const live = object(content.live), observed = sharedContentTime(content.observedAt), started = sharedContentTime(live.startedAt);
  const preview = object(live.preview), cover = object(live.cover), showPreview = live.status === 'live' && !!preview.assetId && preview.status !== 'failed';
  const image = showPreview ? preview : cover, fetched = sharedContentTime(image.fetchedAt);
  const modified = typeof image.imageLastModified === 'string' ? Date.parse(image.imageLastModified) : NaN;
  return <>
    <div className="shared-content-meta"><span>{liveStatusLabels[text(live.status)] || '状态未知'}</span>{text(live.roomId) && <span>直播间 {text(live.roomId)}</span>}{text(live.parentArea) || text(live.area) ? <span>{[text(live.parentArea), text(live.area)].filter(Boolean).join(' / ')}</span> : null}</div>
    <div className="shared-content-meta">{observed && <span>资料获取 {date(observed, { second: '2-digit' })} UTC+8</span>}{started && <span>开播 {date(started)} UTC+8</span>}</div>
    {(Object.keys(image).length > 0) && <><PluginMediaAttachment asset={image} botId={botId} caption={showPreview ? '平台直播预览' : '直播间封面'} /><div className="shared-content-meta">{fetched && <span>图片获取 {date(fetched, { second: '2-digit' })} UTC+8</span>}{Number.isFinite(modified) && <span>图片文件更新 {date(modified, { second: '2-digit' })} UTC+8</span>}</div></>}
  </>;
}

function ContentBody({ content, botId, depth = 0 }: { content: Record<string, unknown>; botId: string; depth?: number }) {
  const subtitle = object(content.subtitle), retrieval = object(content.retrieval), kind = sharedContentKind(content.type);
  const url = sharedContentLink(content.url, content.platform), platform = sharedContentPlatform(content.platform), published = sharedContentTime(content.publishedAt), edited = sharedContentTime(content.editedAt);
  const observed = content.type !== 'live' && sharedContentTime(content.observedAt);
  return <div className="shared-content-body">
    <div className="shared-content-meta">{platform && <span>{platform}</span>}{text(content.author) && <span>{text(content.author)}</span>}{published && <span>发布 {date(published)} UTC+8</span>}{edited && <span>编辑 {date(edited)} UTC+8</span>}{observed && <span>资料获取 {date(observed, { second: '2-digit' })} UTC+8</span>}</div>
    {url && <a href={url} target="_blank" rel="noreferrer">打开{kind}<Icon name="arrow" /></a>}
    {content.type === 'live' && <LiveContent content={content} botId={botId} />}
    {content.type === 'game' && <GameContent content={content} />}
    {Array.isArray(content.blocks) && content.blocks.length ? <ContentBlocks blocks={content.blocks} botId={botId} platform={content.platform} contentType={content.type} /> : text(content.description) && <p>{text(content.description)}</p>}
    {depth < 1 && !!content.original && <div className="shared-content-original"><strong>转发原动态</strong>{text(object(content.original).title) && <p>{text(object(content.original).title)}</p>}<ContentBody content={object(content.original)} botId={botId} depth={depth + 1} /></div>}
    {content.type === 'video' && (subtitle.status === 'ready' && text(subtitle.text) ? <details><summary>字幕</summary><pre>{text(subtitle.text)}</pre></details> : <p className="muted">{subtitle.status === 'login_required' ? '字幕需要登录' : subtitle.status === 'absent' ? '没有可用字幕' : subtitle.status === 'failed' ? '字幕获取失败' : '未取得字幕'}</p>)}
    {retrieval.status !== 'ready' && <p className="muted">资料获取不完整{typeof retrieval.error === 'string' ? ` · ${retrieval.error}` : ''}</p>}
  </div>;
}

export function SharedContents({ contents, botId, images }: { contents: unknown[]; botId: string; images?: unknown }) {
  return <div className="shared-contents">{contents.map((item, index) => {
    const content = object(item), kind = sharedContentKind(content.type);
    if (content.type === 'forward') return <ForwardRecord key={text(content.path) || index} content={content} botId={botId} images={images} />;
    return <details key={text(content.resourceId) || index} className="conversation-tool shared-content"><summary><Icon name={content.type === 'video' || content.type === 'live' ? 'play' : 'document'} /><span>{text(content.title) || `${kind}分享`}</span>{typeof content.durationSeconds === 'number' && <time>{Math.floor(content.durationSeconds / 60)}:{String(Math.floor(content.durationSeconds % 60)).padStart(2, '0')}</time>}</summary><ContentBody content={content} botId={botId} /></details>;
  })}</div>;
}
