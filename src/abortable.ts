/** Stop waiting for host callbacks even when an adapter ignores cancellation. */
export function abortable<T>(work:()=>Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(signal.reason??new Error('Operation cancelled.'));
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{signal.throwIfAborted();return work();}).then(resolve,reject)
      .finally(()=>signal.removeEventListener('abort',abort));
  });
}
