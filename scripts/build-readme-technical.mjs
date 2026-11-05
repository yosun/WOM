// Render the README technical plate from checked-in, provenance-pinned demo images.
// No services or generation models are called. npm ci; node scripts/build-readme-technical.mjs
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './slides/browser.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'docs/images');
const assets = path.join(out, 'wom-technical-assets');
const provenance = JSON.parse(await readFile(path.join(assets,'provenance.json'),'utf8'));
const W=1800,H=2440;
const C={bg:'#111411',panel:'#191e19',line:'#3c493d',text:'#f2f1e6',muted:'#bdc7ba',gold:'#edbd78',green:'#a8d19b',coral:'#f2a38e',blue:'#a0c9e8'};
const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const items=[],defs=[];
const text=(x,y,s,size=28,fill=C.text,attrs='')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${attrs}>${xml(s)}</text>`;
const rect=(x,y,w,h,fill=C.panel,stroke=C.line,r=14)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`;
const line=(x1,y1,x2,y2,color=C.line,extra='')=>`<path d="M${x1} ${y1}L${x2} ${y2}" fill="none" stroke="${color}" stroke-width="2" ${extra}/>`;
const title=(number,y,label,detail)=>{items.push(text(48,y,number,28,C.gold,'font-weight="700"'),text(104,y,label,35,C.text,'font-weight="600"'));if(detail)items.push(text(104,y+38,detail,25,C.muted));};
let imageCount=0;
async function image(name,x,y,w,h,{fill='#0a0e0a',fit='meet',border=C.line}={}){
 const bytes=await readFile(path.join(assets,name));
 const sha=createHash('sha256').update(bytes).digest('hex');
 // Check the sanitized artifact digest without reading any original local worlds.
 const record=provenance.assets.find(a=>a.file===name);
 if(!record?.sha256 || sha!==record.sha256)throw new Error('Asset hash missing or changed: '+name);
 const id='image-'+imageCount++;
 defs.push(`<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/></clipPath>`);
 const mime=name.endsWith('.png')?'image/png':'image/jpeg';
 return rect(x,y,w,h,fill,border,12)+`<image x="${x}" y="${y}" width="${w}" height="${h}" href="data:${mime};base64,${bytes.toString('base64')}" preserveAspectRatio="xMidYMid ${fit}" clip-path="url(#${id})"/>`;
}
items.push(rect(0,0,W,H,C.bg,'none',0));
items.push(text(48,49,'WOM / WORLD OF A MEMORY',24,C.gold,'letter-spacing="2" font-weight="600"'));
items.push(text(1752,49,'wom.quest',28,C.gold,'text-anchor="end"'));
items.push(text(48,119,'Rebuild the scene. Keep the evidence.',66,C.text,'font-family="Georgia, serif"'));
items.push(text(48,164,'WOMPar reconstruction + WOMAgent repair · actual retained Sunny Garden demo outputs',28,C.muted));
items.push(line(48,193,1752,193));

title('01',242,'Muse plans the scene; SAM separates its subjects');
const initial=[
 ['source.jpg','Source photograph','1920 × 1280 · one shared scene'],
 ['masks.jpg','SAM 3.1 object masks','4 foreground subjects isolated'],
 ['clean-plate.jpg','Muse Image clean plate','Erase subjects → rebuild surroundings'],
 ['depth.png','MoGe-3 predicted depth','1024 × 683 · near gold / far blue'],
];
for(let i=0;i<initial.length;i++){
 const x=48+i*432;
 items.push(await image(initial[i][0],x,269,408,230));
 items.push(text(x,542,initial[i][1],29,C.text,'font-weight="600"'),text(x,579,initial[i][2],23,C.muted));
}
items.push(line(48,604,1752,604));

title('02',651,'Reconstruct objects and the surrounding world');
items.push(text(104,690,'Masked / completed cutouts feed object models. The clean plate feeds the world model.',25,C.muted));
const branches=[
 ['mesh.png','Image → textured mesh','Tripo H3.1 · model.glb','Retained alternative object asset'],
 ['gaussian.jpg','Image → Gaussian object','TripoSplat · model.ply','Shown preview; IDOL is also supported'],
 ['world.jpg','Image → surrounding world','World Labs Marble · .spz','Retained generated world preview'],
];
for(let i=0;i<branches.length;i++){
 const x=48+i*578;
 items.push(rect(x,714,548,318),await image(branches[i][0],x+10,724,528,205,{border:'none'}));
 items.push(text(x+20,970,branches[i][1],31,C.text,'font-weight="600"'),text(x+20,1010,branches[i][2],27,C.gold));
 items.push(text(x+20,1064,branches[i][3],24,C.muted));
}

title('03',1134,'Compose in the original camera frame');
items.push(text(104,1172,'Fit position, orientation and scale to the SAM mask; use metric depth and the ground plane.',25,C.muted));
items.push(await image('fit-overlay.jpg',48,1202,824,280));
items.push(await image('source-view.jpg',900,1202,414,259),await image('novel-view.jpg',1338,1202,414,259));
items.push(text(48,1524,'Saved bench fit: IoU 0.80 → grounded 0.82',28,C.green,'font-weight="600"'));
items.push(text(48,1560,'Magenta = SAM target · cyan = projected silhouette',25,C.muted));
items.push(text(900,1503,'Source camera',27,C.text,'font-weight="600"'),text(1338,1503,'Novel camera · right',27,C.text,'font-weight="600"'));
items.push(text(900,1541,'Frozen camera poses reveal parallax and hidden surfaces.',24,C.muted));
items.push(text(900,1578,'Marble calibration: 58.8° HFOV · 15,772 depth samples',24,C.blue));
items.push(line(48,1608,1752,1608));

title('04',1656,'WOMAgent: investigate → test a repair → replay → verify');
items.push(text(104,1694,'A real retained replay: replace a contaminated bicycle asset, then check the same 15 camera views.',25,C.muted));
items.push(await image('repair-before.jpg',48,1722,830,519),await image('repair-after.jpg',922,1722,830,519));
items.push(text(68,2209,'BEFORE / IDOL bicycle',27,'#ffffff','font-weight="700" stroke="#0d110d" stroke-width="4" paint-order="stroke"'));
items.push(text(942,2209,'AFTER / retained Tripo H3.1 mesh',27,'#ffffff','font-weight="700" stroke="#0d110d" stroke-width="4" paint-order="stroke"'));
// Annotate the visible contamination without changing the scene pixels.
items.push(`<rect x="62" y="1989" width="192" height="233" rx="10" fill="none" stroke="${C.coral}" stroke-width="3" stroke-dasharray="9 7"/>`);
items.push(rect(48,2260,1704,66,'#202b20','#56674f',12));
items.push(text(78,2303,'15 / 15 views verified',30,C.green,'font-weight="600"'),text(630,2303,'Existing asset swap',30,C.text),text(1213,2303,'0 new generation jobs',30,C.gold));
items.push(text(48,2367,'One replay: 9 sightings fixed; 32 issues remained open. Budget-limited run; no Global Par claim.',25,C.muted));
items.push(text(48,2410,'WOMetrics retains masks, poses, rendered views, tool traces, verification outcomes, cost and time.',25,C.muted));
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc" font-family="Arial, Helvetica, sans-serif"><title id="title">WOM technical reconstruction and verified repair</title><desc id="desc">Actual matching Sunny Garden source, SAM masks, clean plate, metric depth, Tripo mesh and Gaussian object previews, Marble world, silhouette-fit overlays, source and novel camera renders, and a real before-after asset replacement verified over fifteen camera views. This is one retained run, not a global benchmark result.</desc><metadata>${xml(JSON.stringify({schema:'wom-readme-technical-plate/1',assets:'wom-technical-assets/provenance.json',replay:'https://wom.quest/u/yosun/mvxixlbz34cbfb22/agents',modelsShown:{mesh:'tripo-v31',gaussian:'triposplat',world:'worldlabs'},noNewGeneration:true}))}</metadata><defs>${defs.join('')}</defs>${items.join('\n')}</svg>\n`;
await writeFile(path.join(out,'wom-technical-overview.svg'),svg);
const temp=await mkdtemp(path.join(os.tmpdir(),'wom-technical-figure-'));
const browser=await launch();
try{
 const page=await browser.newPage({viewport:{width:W,height:H},deviceScaleFactor:1});
 await page.route(/^https?:/,route=>route.abort());
 const html=path.join(temp,'figure.html');
 await writeFile(html,`<!doctype html><meta charset="utf-8"><title>WOM technical figure</title><style>body{margin:0;background:${C.bg}}svg{display:block}</style>${svg}`);
 await page.goto(pathToFileURL(html).href);
 await page.evaluate(()=>document.fonts.ready);
 const labels=await page.locator('svg text').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBBox();return{text:n.textContent,x:b.x,y:b.y,w:b.width,h:b.height};}));
 const overflows=labels.filter(b=>b.x<0||b.y<0||b.x+b.w>W||b.y+b.h>H);
 const overlaps=[];
 for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){
  const a=labels[i],b=labels[j];const dx=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x),dy=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
  if(dx>3&&dy>3)overlaps.push([a.text,b.text]);
 }
 if(overflows.length||overlaps.length)throw new Error(JSON.stringify({overflows,overlaps}));
 await page.locator('svg').screenshot({path:path.join(out,'wom-technical-overview.png')});
 console.log(JSON.stringify({figure:'docs/images/wom-technical-overview.png',width:W,height:H,retainedImagePanels:imageCount,textLabels:labels.length,labelOverlaps:0,textOverflows:0,networkRequests:0}));
}finally{await browser.close();await rm(temp,{recursive:true,force:true});}
