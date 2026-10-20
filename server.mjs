import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(fileURLToPath(new URL('./dist/',import.meta.url)));
const port=Number(process.env.LINK65_PORT??8765);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost'),relative=decodeURIComponent(url.pathname).replace(/^\/+/,''),file=path.resolve(root,relative||'index.html');
    if(file!==root && !file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
    const info=await stat(file);if(!info.isFile()){res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':types[path.extname(file)]??'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Permissions-Policy':'hid=(self), usb=(self)','Referrer-Policy':'no-referrer'});
    res.end(req.method==='HEAD'?undefined:await readFile(file));
  }catch{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}).end('Not found');}
});
server.listen(port,'127.0.0.1',()=>process.stdout.write(`Link65 Studio: http://127.0.0.1:${port}\n`));
server.on('error',error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
