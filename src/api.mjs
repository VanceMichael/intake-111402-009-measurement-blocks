import {createServer} from 'node:http';

const FILTERS = ['fileId','revision','groupId','recordId','recordIndex','blockId'];

export async function createApi(archive,port = 0) {
  const server = createServer(async (request,response) => {
    try {
      if (request.method !== 'GET') {response.writeHead(404);return response.end();}
      const url = new URL(request.url,'http://127.0.0.1');
      if (url.pathname === '/health') {
        response.writeHead(200,{'content-type':'application/json; charset=utf-8'});
        return response.end(JSON.stringify({status:'ok'},null,2));
      }
      if (url.pathname === '/records') {
        const filters = Object.fromEntries(FILTERS
          .filter(key => url.searchParams.has(key))
          .map(key => [key,url.searchParams.get(key)]));
        const body = Object.keys(filters).length ? await archive.query(filters) : await archive.list();
        response.writeHead(200,{'content-type':'application/json; charset=utf-8'});
        return response.end(JSON.stringify(body,null,2));
      }
      response.writeHead(404);
      response.end();
    } catch(error) {response.writeHead(500);response.end(JSON.stringify({error:error.message}));}
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  return {origin:`http://127.0.0.1:${server.address().port}`,close:() => new Promise(resolve => server.close(resolve))};
}
