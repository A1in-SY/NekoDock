import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './ui';
import './image-preview.css';

export function ConversationImage({ src, alt, onError }: { src: string; alt: string; onError?: () => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} className="conversation-image-trigger" type="button" aria-label={`预览${alt}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <img className="conversation-image" src={src} alt={alt} loading="lazy" onError={onError} />
    </button>
    {open && createPortal(<ImagePreview key={src} src={src} alt={alt} onClose={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }} />, document.body)}
  </>;
}

function ImagePreview({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [originalSize, setOriginalSize] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = () => { dialog.current?.close(); onClose(); };
  useEffect(() => {
    const element = dialog.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element?.showModal();
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  return <dialog ref={dialog} className="image-preview" aria-labelledby={title} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="image-preview-panel">
      <header className="image-preview-header">
        <h2 id={title}>图片预览</h2>
        <div>
          {!failed && <button className="image-preview-size" type="button" aria-pressed={originalSize} onClick={() => setOriginalSize(value => !value)}>{originalSize ? '适应窗口' : '原始尺寸'}</button>}
          <button className="image-preview-close" type="button" aria-label="关闭图片预览" autoFocus onClick={close}><Icon name="close" /></button>
        </div>
      </header>
      <div className={'image-preview-stage' + (originalSize ? ' original-size' : '')} onClick={event => { if (event.target === event.currentTarget) close(); }}>
        {failed ? <p role="status">图片加载失败，缓存可能已过期。</p> : <img src={src} alt={alt} onError={() => setFailed(true)} />}
      </div>
    </section>
  </dialog>;
}
