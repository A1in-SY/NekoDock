import { resolve } from 'node:path';
import { createConsole } from './server.js';
import { DockerClient } from './docker.js';
import { createLogger, logEvent } from '../logging.js';
const logger=createLogger();
async function main(){
 const port=Number(process.env.CONSOLE_PORT??4180);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('CONSOLE_PORT 无效');
 const docker=new DockerClient({socketPath:process.env.DOCKER_SOCKET??'/var/run/docker.sock',image:process.env.WORKER_IMAGE??'nekodock-worker:latest',network:process.env.WORKER_NETWORK??'nekodock',consoleUrl:process.env.WORKER_CONSOLE_URL??'http://console:4180'});
 const {app}=await createConsole({dataDir:resolve(process.env.CONSOLE_DATA_DIR??'data/console'),docker});
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>void app.close());
 await app.listen({port,host:process.env.CONSOLE_HOST??'0.0.0.0'});logEvent(logger,'info','console.listening',{port});
}
main().catch(()=>{logEvent(logger,'error','console.start_failed');process.exitCode=1;});
