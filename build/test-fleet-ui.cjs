// Isolated packaged UI -> real connector -> three local TCP simulators.
// No physical printer address, port 9100, or operator profile is used.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),resources=process.env.ZBRE_QA_RESOURCES||path.join(root,'dist/win-unpacked/resources'),web=path.join(resources,'web');
const output=path.join(root,'build/fleet-qa');fs.mkdirSync(output,{recursive:true});const runDir=fs.mkdtempSync(path.join(output,'run-'));
app.setPath('userData',path.join(runDir,'profile'));let win,server,connector,logs='',origin,agent;const printers=[],sockets=new Set();
const delay=ms=>new Promise(r=>setTimeout(r,ms));const js=code=>win.webContents.executeJavaScript(code,true);
async function poll(fn,msg,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(100)}throw Error(msg)}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port}
function child(exe,args,opts={}){const p=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],...opts});p.stdout.on('data',d=>logs+=d);p.stderr.on('data',d=>logs+=d);return p}
async function click(text){await poll(()=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(text)}&&!b.disabled);if(b){b.click();return true}return false})()`),'Missing enabled button '+text,30000)}
async function stepper(label){await poll(()=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.lastElementChild?.textContent===${JSON.stringify(label)}&&!b.disabled);if(b){b.click();return true}return false})()`),'Stepper '+label,30000)}
async function fill(label,value){await js(`(()=>{const e=document.querySelector('[aria-label="${label}"]');if(!e)throw Error('Missing ${label}');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`)}
async function api(action,data={}){const r=await fetch(agent+'/v1/tcp/job',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({action,...data})});if(!r.ok)throw Error(action+': '+await r.text());return r.json()}
async function makePrinter(host,index){
 const p={valid:0,void:0,total:0,paused:index!==0,headOpen:false,frames:[],commands:[],queue:[],processing:false,maxQueue:0,firstLabelAt:0};
 p.server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let pending='';
  const work=()=>{if(p.processing)return;p.processing=true;const next=()=>{if(p.paused||p.headOpen||!p.queue.length){p.processing=false;return};const {zpl,job,ordinal}=p.queue.shift();p.total++;const bad=ordinal===7&&p.frames.length<100;p.void+=bad?1:0;p.valid+=bad?0:1;const epc=bad?'':((index+1)*1000000+p.valid).toString(16).toUpperCase().padStart(24,'0');p.firstLabelAt ||= Date.now();p.frames.push({job,ordinal,epc,zpl});if(!socket.destroyed){const data=`NWEP|${job}|${ordinal}|${epc}|END\r\n`;socket.write(data.slice(0,3));socket.write(data.slice(3))};setTimeout(next,20)};next()};
  socket.on('data',data=>{pending+=data.toString();try{while(pending){pending=pending.replace(/^[\r\n ]+/,'');if(!pending)break;
   if(pending.startsWith('~HQES')){pending=pending.slice(5);socket.write(`\x02\r\nPRINTER STATUS\r\nERRORS: ${p.headOpen?1:0} 00000000 ${p.headOpen?'00000004':'00000000'}\r\nWARNINGS: 0 00000000 00000000\r\n\x03\r\n`)}
   else if(pending.startsWith('~HS')){pending=pending.slice(3);socket.write(`\x02000,0,${p.paused?1:0},0251,${String(p.queue.length).padStart(3,'0')},0,0,0,000,0,0,0\x03\r\n\x02000,0,${p.headOpen?1:0},0,1,2,6,0,00000000,1,001\x03\r\n\x021234,1\x03\r\n`)}
   else if(pending.startsWith('! U1 getvar ')&&pending.includes('\n')){const at=pending.indexOf('\n')+1,c=pending.slice(0,at);pending=pending.slice(at);const value=c.includes('valid_resettable')?p.valid:c.includes('void_resettable')?p.void:c.includes('total_label_count')?p.total:'?';socket.write(`"${value}"\r\n`)}
   else if(pending.startsWith('! U1 setvar ')){throw Error('Application reset counters')}
   else if(/^~(PP|PS|JA)/.test(pending)){const c=pending.slice(0,3);pending=pending.slice(3);p.commands.push(c);if(c==='~PP')p.paused=true;if(c==='~PS'){p.paused=false;work()}if(c==='~JA')p.queue=[]}
   else if(pending.startsWith('^JZN')||pending.startsWith('~JZN'))pending=pending.slice(4);
   else if(pending.startsWith('^XA')&&pending.includes('^XZ')){const at=pending.indexOf('^XZ')+3,zpl=pending.slice(0,at);pending=pending.slice(at);const hv=zpl.match(/\^HV1,256,NWEP\|([^|]+)\|(\d+)\|,/);if(hv){p.queue.push({zpl,job:hv[1],ordinal:Number(hv[2])});p.maxQueue=Math.max(p.maxQueue,p.queue.length);work()}}
   else break;
  }}catch(e){logs+='\nSIM ERROR '+e.stack;socket.destroy()}});
 });await new Promise(r=>p.server.listen(0,host,r));p.port=p.server.address().port;assert.notEqual(p.port,9100);printers.push(p);return p;
}
async function main(){
 const manifest=JSON.parse(fs.readFileSync(path.join(resources,'runtime-manifest.json'),'utf8'));assert.equal(manifest.web.packageVersion,'3.9.2');assert.equal(manifest.connector.version,'0.12.2');
 const host=Object.values(os.networkInterfaces()).flat().find(a=>a.family==='IPv4'&&!a.internal&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))?.address;assert.ok(host);
 for(let i=0;i<3;i++)await makePrinter(host,i);
 const connectorPort=await freePort();agent=`http://127.0.0.1:${connectorPort}`;
 connector=child(path.join(resources,'connector/ZbrePrinterLocalPrintAgent-windows-x64.exe'),['--port',String(connectorPort),'--tcp-ports',printers.map(p=>p.port).join(','),'--state-file',path.join(runDir,'connector/paired-origins.json')]);
 await poll(async()=>{try{return(await(await fetch(agent+'/v1/health')).json()).capabilities.fleetSpoolV1}catch{return false}},'connector startup');
 const port=await freePort();origin=`http://127.0.0.1:${port}`;server=child('node',[path.join(web,'server.js')],{cwd:web,env:{...process.env,NODE_PATH:path.join(web,'standalone_modules'),PORT:String(port),HOSTNAME:'127.0.0.1',NODE_ENV:'production',NEXTWAVES_DEPLOYMENT_MODE:'desktop',NEXTWAVES_SERVER_TCP:'disabled',NEXTWAVES_DATA_DIR:path.join(runDir,'data')}});
 await poll(async()=>{try{return(await fetch(origin)).ok}catch{return false}},'web startup');await app.whenReady();win=new BrowserWindow({show:false,width:1500,height:1150,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
 win.webContents.on('console-message',e=>{logs+='\nUI '+e.message});win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!(d.url.startsWith(origin+'/')||d.url.startsWith(agent+'/')||/^(blob:|data:)/.test(d.url))}));
 const doc={id:'fleet-qa',name:'Fleet EPC QA',settings:{widthMm:45,heightMm:20,gapMm:3,dpi:203,targetPrinterModel:'zt610r',copies:2500,speed:4,darkness:10,serial:{enabled:false,start:1,step:1,pad:4,prefix:''},rfid:{enabled:false,readEnabled:true,captureToHost:true,readBank:'EPC',readFieldName:'rfid_read',zebraEpcReadMode:'pc',zebraModel:'zt610r',zebraUsePrinterSettings:true,chip:'epc_96',epcBits:96,format:'H',retries:3,block:2,words:6,data:''}},elements:[{id:'read-text',kind:'text',text:'{rfid_read}',pos:{x:2,y:2},size:{w:41,h:7},rotation:0,font:'D',scaleX:1,scaleY:1}]};
 if(process.env.ZBRE_QA_TEMPLATE){const template=JSON.parse(fs.readFileSync(process.env.ZBRE_QA_TEMPLATE,'utf8'));Object.assign(doc,template);doc.settings.copies=2500;doc.settings.rfid.captureToHost=true;}
 const profiles=printers.map((p,i)=>({id:'printer-'+i,host,port:p.port,settings:{connectionMode:'tcp',tcpHost:host,tcpPort:p.port,tcpExecutionMode:'connector',printAgentUrl:agent,language:'zpl',headWidthMm:0,hAlign:'left',labelTopDots:0,leftPositionDots:0,embedAlignmentInJobs:false,embedTearOffInJobs:false,baudRate:9600,serialFlowControl:'none',printerName:''},doc:{...structuredClone(doc),name:'Printer '+(i+1)}}));
 await win.loadURL(origin);await js(`localStorage.setItem('zbre.print.session.v1',${JSON.stringify(JSON.stringify({doc:profiles[0].doc,step:'print',hasDoc:true}))});localStorage.setItem('zbre.print.printer.v1',${JSON.stringify(JSON.stringify(profiles[0].settings))});localStorage.setItem('zbre.fleet.v1',${JSON.stringify(JSON.stringify(profiles))})`);await win.loadURL(origin);
 await poll(()=>js(`document.querySelectorAll('[data-testid="fleet-printer"]').length===3`),'fleet render');
 for(let i=0;i<3;i++){
  if(i)await js(`document.querySelectorAll('[data-testid="fleet-printer"]')[${i}].querySelector('button').click()`);
  await poll(()=>js(`document.querySelectorAll('[data-testid="fleet-printer"]')[${i}].innerText.includes('Đang chọn')`),'printer selection committed');
  printers[i].requestedAt=Date.now();await click('Print 2500 labels');await poll(async()=>{const list=await api('spool-list');return list.jobs.some(j=>j.port===printers[i].port&&j.state==='printing')},'independent spool '+i);
  if(i===0){
   await poll(()=>printers[0].firstLabelAt>0,'first label before full preparation');
   await poll(()=>js(`(()=>{const card=document.querySelector('[data-testid="selected-fleet-job"]');const b=[...(card?.querySelectorAll('button')||[])].find(b=>b.innerText.trim()==='Tạm dừng'&&!b.disabled);if(b){b.click();return true}return false})()`),'pause first printer after measuring startup');
   await poll(()=>printers[0].paused,'first printer paused while preparing other two');
  }
  await poll(()=>js(`![...document.querySelectorAll('[data-testid="fleet-printer"] button')].find(b=>b.innerText.includes('Đang chọn'))?.disabled`),'renderer released after commit');
 }
 const firstLabelLatencyMs=printers[0].firstLabelAt-printers[0].requestedAt;assert.ok(firstLabelLatencyMs>0&&firstLabelLatencyMs<10000,'first label latency '+firstLabelLatencyMs);
 const simultaneous=await api('spool-list');assert.equal(simultaneous.jobs.filter(j=>j.state==='printing').length,3);
 await stepper('Edit');await stepper('Print');await poll(()=>js(`!!document.querySelector('[data-testid="selected-fleet-job"]')&&[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Print 2500 labels'&&b.disabled)`),'active job survives Edit/Print');
 await delay(500);fs.writeFileSync(path.join(runDir,'three-printers.png'),(await win.webContents.capturePage()).toPNG());
 // A renderer reload must not cancel or replay any committed job.
 await win.loadURL(origin);await poll(()=>js(`document.querySelectorAll('[data-testid="fleet-printer"]').length===3`),'fleet after reload');
 await poll(()=>js(`document.querySelectorAll('[data-testid="fleet-printer"] button').length>=9`),'controls after reload');
 await js(`[...document.querySelectorAll('[data-testid="fleet-printer"] button')].filter(b=>b.innerText.trim()==='Tiếp tục').forEach(b=>b.click())`);
 await poll(async()=>{const data=await api('spool-list');const stopped=data.jobs.find(j=>j.state==='needs_review');if(stopped)throw Error(stopped.error);return data.jobs.filter(j=>j.state==='done').length===3},'physical completion');
 printers.forEach(p=>assert.equal(p.frames.length,2500));let list=await api('roll-list',{production:{}});assert.equal(list.rolls.length,3);
 const selected=list.rolls.find(r=>r.printerPort===printers[2].port),rollId=selected.rollId;
 await click('Tiếp tục cuộn cũ');
 // Add a real row note through UI, verify immediate persistence and input clearing.
 await js(`[...document.querySelectorAll('summary')].find(e=>e.innerText.trim()==='Ghi chú dòng / sự cố').click()`);
 await poll(()=>js(`!!document.querySelector('[aria-label="Note row 2"]')`),'note rows');await js(`document.querySelector('[aria-label="Note row 2"]').click()`);await fill('Row note','Kiểm tra sau chỉnh giấy');await click('Áp dụng ghi chú');
 await poll(()=>js(`document.querySelector('[aria-label="Row note"]').value===''&&!document.querySelector('[aria-label="Note row 2"]').checked`),'note clear only after save');
 let roll=await api('roll-get',{production:{rollId}});assert.equal(roll.rows[1].notes[0],'Kiểm tra sau chỉnh giấy');
 // Modify layout/speed in the persisted per-printer draft, then explicitly continue the same roll.
 const changed=structuredClone(profiles[2].doc);changed.settings.copies=5;changed.settings.speed=3;changed.settings.darkness=12;changed.elements[0].pos.x=2.5;
 await js(`localStorage.setItem('zbre.print.session.v1',${JSON.stringify(JSON.stringify({doc:changed,step:'print',hasDoc:true}))})`);await win.loadURL(origin);await click('Tiếp tục cuộn cũ');await click('Print 5 labels');
 await poll(async()=>{const data=await api('spool-history');return data.jobs.filter(j=>j.port===printers[2].port&&j.state==='done').length===2},'adjusted top-up completion');
 roll=await api('roll-get',{production:{rollId}});assert.equal(roll.roll.runs.length,2);assert.equal(roll.summary.validCount,2504);assert.equal(roll.summary.voidCount,1);assert.equal((await api('roll-list',{production:{}})).rolls.length,3);
 // Head-open before payload: stop that run, keep the roll, then explicitly recover.
 printers[2].headOpen=true;
 await click('Print 5 labels');await poll(async()=> (await api('spool-list')).jobs.some(j=>j.port===printers[2].port&&j.state==='not_sent'),'head-open stop');
 assert.equal(printers[2].frames.length,2505);
 printers[2].headOpen=false; // Keep the fault-induced Pause until explicit UI Resume.
 await click('Print 5 labels');
 // Recovery deliberately keeps the printer paused; the operator explicitly resumes.
 await poll(async()=> (await api('spool-list')).jobs.some(j=>j.port===printers[2].port&&j.state==='printing'&&j.paused),'recovered run paused');
 await poll(()=>js(`(()=>{const card=document.querySelectorAll('[data-testid="fleet-printer"]')[2];const b=[...card.querySelectorAll('button')].find(b=>b.innerText.trim()==='Tiếp tục'&&!b.disabled);if(b){b.click();return true}return false})()`),'operator resumes repaired printer');
 await poll(async()=> (await api('spool-history')).jobs.filter(j=>j.port===printers[2].port&&j.state==='done').length===3,'same roll after head adjustment');
 roll=await api('roll-get',{production:{rollId}});assert.equal(roll.summary.validCount,2509);assert.equal(roll.roll.runs.length,4);assert.equal(roll.summary.voidCount,1);
 await click('Đóng cuộn');await poll(async()=> (await api('roll-get',{production:{rollId}})).roll.state==='closed','operator closure');
 const exportResponse=await fetch(agent+'/v1/tcp/job',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({action:'roll-export',production:{rollId,jobId:'FLEET-QA',rollNumber:1,operator:'QA'}})});assert.ok(exportResponse.ok,await exportResponse.clone().text());const bytes=Buffer.from(await exportResponse.arrayBuffer());assert.ok(bytes.toString().includes('printer_ip,'+host));assert.ok(bytes.toString().includes('note=Kiểm tra sau chỉnh giấy'));
 // Cancel from the selected Print panel, without restarting the renderer/host.
 await js(`document.querySelectorAll('[data-testid="fleet-printer"]')[0].querySelector('button').click()`);
 await poll(()=>js(`document.querySelectorAll('[data-testid="fleet-printer"]')[0].innerText.includes('Đang chọn')`),'first printer selected');
 await click('Tiếp tục cuộn cũ');await fill('Labels',2500);const cancelStart=printers[0].frames.length;
 await click('Print 2500 labels');await poll(()=>printers[0].frames.length>=cancelStart+30,'cancel run started');
 const cancelAt=Date.now();await poll(()=>js(`(()=>{const card=document.querySelector('[data-testid="selected-fleet-job"]');const b=[...(card?.querySelectorAll('button')||[])].find(b=>b.innerText.trim()==='Cancel batch'&&!b.disabled);if(b){b.click();return true}return false})()`),'visible host cancel');
 await poll(async()=> (await api('spool-list')).jobs.some(j=>j.port===printers[0].port&&j.state==='cancelled'),'cancel confirmed',15000);
 const cancelledLabels=printers[0].frames.length-cancelStart;assert.ok(cancelledLabels<2500);assert.equal(printers[0].queue.length,0);assert.ok(printers[0].commands.includes('~JA'));
 const cancelMs=Date.now()-cancelAt;await stepper('Edit');await stepper('Print');await fill('Labels',5);await click('Print 5 labels');
 await poll(async()=> (await api('spool-list')).jobs.some(j=>j.port===printers[0].port&&j.state==='printing'&&j.paused),'next run awaits resume');
 await poll(()=>js(`(()=>{const card=document.querySelector('[data-testid="selected-fleet-job"]');const b=[...(card?.querySelectorAll('button')||[])].find(b=>b.innerText.trim()==='Tiếp tục'&&!b.disabled);if(b){b.click();return true}return false})()`),'resume next run');
 await poll(async()=> (await api('spool-list')).jobs.some(j=>j.port===printers[0].port&&j.state==='done'),'print after cancel and Edit/Print');
 assert.equal(printers[0].frames.length,cancelStart+cancelledLabels+5);printers.forEach(p=>assert.ok(p.maxQueue<=20,'lookahead exceeded: '+p.maxQueue));
 // Reproduce the user's rejected new roll with nonzero printer counters.
 await js(`document.querySelectorAll('[data-testid="fleet-printer"]')[2].querySelector('button').click()`);
 await poll(()=>js(`document.querySelectorAll('[data-testid="fleet-printer"]')[2].innerText.includes('Đang chọn')`),'baseline printer selected');
 await fill('Labels',1);const beforeRejected=printers[2].frames.length;await click('Print 1 label');
 await poll(async()=> (await api('spool-list')).jobs.some(j=>j.port===printers[2].port&&j.state==='not_sent'&&j.error.includes('VALID 2509')),'early counter rejection');
 await poll(()=>js(`document.body.innerText.includes('VALID 2509, VOID 1')&&!document.body.innerText.includes('Host đã lưu lượt')`),'actual baseline reason replaces successful handoff notice');
 assert.equal(printers[2].frames.length,beforeRejected,'rejected baseline printed a label');
 fs.writeFileSync(path.join(runDir,'roll.csv'),bytes);fs.writeFileSync(path.join(runDir,'completed.png'),(await win.webContents.capturePage()).toPNG());
 const result={ok:true,version:manifest.web.packageVersion,connector:manifest.connector.version,simultaneousPrinters:3,firstLabelLatencyMs,template:process.env.ZBRE_QA_TEMPLATE||null,labels:printers.map(p=>p.frames.length),sameRollAfterRevision:true,headFaultRecoveredInSameRoll:true,explicitResumeAfterRecovery:true,editPrintWithoutRestart:true,hostCancel:true,cancelMs,cancelledLabels,maxQueue:printers.map(p=>p.maxQueue),rowNoteClearedAfterSave:true,csvSHA256:createHash('sha256').update(bytes).digest('hex'),runDir};fs.writeFileSync(path.join(output,'latest-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
async function close(code){fs.writeFileSync(path.join(runDir,'process.log'),logs);if(win&&!win.isDestroyed())win.destroy();server?.kill();connector?.kill();for(const s of sockets)s.destroy();for(const p of printers)p.server.close();app.exit(code)}
main().then(()=>close(0)).catch(async e=>{console.error(e);if(win&&!win.isDestroyed()){fs.writeFileSync(path.join(runDir,'failure.txt'),await js('document.body.innerText+\"\\nDETAILS\\n\"+[...document.querySelectorAll(\"details\")].map(d=>d.textContent).join(\"\\n\")'));fs.writeFileSync(path.join(runDir,'failure.png'),(await win.webContents.capturePage()).toPNG())}logs+='\n'+e.stack;await close(1)});
