import type { PublicBot } from '../../src/console/contracts';

export function cancellationRequestId():string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
}

export function replyCancellationState(bot:PublicBot,requested:{runId:string;time:number}|null,now=Date.now()) {
  const control=bot.runControl,active=control?.active;
  const cancellation=control?.cancellation;
  const targetId=active?.runId??requested?.runId;
  const matching=cancellation&&cancellation.runId===targetId?cancellation:null;
  const terminal=matching?.status==='cancelled'||matching?.status==='already_finished';
  const waiting=!terminal&&!!(requested&&(!active||active.runId===requested.runId)||active&&(
    active.phase==='cancelling'||matching?.status==='requested'||matching?.status==='received'));
  const requestedAt=requested?.runId===targetId?requested?.time:matching?.createdAt;
  const unconfirmed=waiting&&(requestedAt!==undefined&&now-requestedAt>=10_000||bot.lastHeartbeat===null||now-bot.lastHeartbeat>15_000);
  return {
    runId:active?.runId??null,
    disabled:!control?.supported||!active||bot.state==='stopped'||waiting||!!terminal,
    title:!control?.supported?'更新实例后可使用停止当前回复':'停止本轮生成和未发出的回复，保留已发送内容',
    waiting,
    message:waiting?(unconfirmed?'停止尚未确认，正在等待实例回执。':active?.phase==='cancelling'?'正在停止当前回复；已发出的消息会继续确认回执。':'停止请求已接受，正在等待实例处理。'):'',
  };
}
