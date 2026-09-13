import net from 'node:net';
const port = Number(process.env.MOCK_POOL_PORT || 19333);
const server = net.createServer((socket) => {
  let buf='';
  socket.on('data', c => {
    buf += c.toString();
    for (;;) {
      const i=buf.indexOf('\n'); if(i<0) break;
      const line=buf.slice(0,i).trim(); buf=buf.slice(i+1); if(!line) continue;
      const m=JSON.parse(line);
      if(m.method==='mining.subscribe') socket.write(JSON.stringify({id:m.id,result:[[['mining.notify','subid']],'cafebabe',4],error:null})+'\n');
      else if(m.method==='mining.authorize') {
        socket.write(JSON.stringify({id:m.id,result:true,error:null})+'\n');
        socket.write(JSON.stringify({id:null,method:'mining.set_difficulty',params:[10000]})+'\n');
        socket.write(JSON.stringify({id:null,method:'mining.notify',params:['job-http','11'.repeat(32),'0102','0304',[],'20000000','1702abcd','65f00000',true]})+'\n');
      } else if(m.method==='mining.submit') socket.write(JSON.stringify({id:m.id,result:true,error:null})+'\n');
    }
  });
});
server.listen(port,'127.0.0.1',()=>console.log(`mock:${port}`));
