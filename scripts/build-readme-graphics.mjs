// Self-contained, editable vector figures. Measurements come from the recorded study summary.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const out = new URL('docs/images/', root);
await mkdir(out, { recursive: true });
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (x,y,s,size=22,fill='#f4ede2',extra='') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;
const box = (x,y,w,h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#211d18" stroke="#65513a"/>`;
const svg = (title,desc,height,body) => `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="${height}" viewBox="0 0 1280 ${height}" role="img" aria-labelledby="title desc"><title id="title">${esc(title)}</title><desc id="desc">${esc(desc)}</desc><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0L6 3L0 6" fill="none" stroke="#e8b26a"/></marker></defs><rect width="1280" height="${height}" rx="24" fill="#12100e"/><g font-family="Arial, Helvetica, sans-serif">${body}</g></svg>\n`;
let b = text(48,49,'WOM / PHOTO → WORLD → EVIDENCE',17,'#e8b26a','letter-spacing="2"') + text(48,106,'One image. A world you can inspect.',45,'#f4ede2','font-family="Georgia, serif"');
const stages = [
 ['01 / YOUR PHOTO','Start with a moment.','JPG, PNG, WebP or HEIC','in the hosted application.'],
 ['02 / RECONSTRUCT','Build objects + surroundings.','Muse plans · SAM segments','MoGe depth · IDOL / Tripo · Marble'],
 ['03 / EXPLORE','Step beyond the frame.','View the composed scene.','Walk, orbit and save new views.'],
 ['04 / MEASURE','Keep the evidence.','Fidelity · placement · asset quality','Camera · failures · cost · time'],
];
for (let i=0;i<stages.length;i++) {
 const x=48+i*302; b += box(x,149,278,194)+text(x+20,185,stages[i][0],16,'#e8b26a')+text(x+20,230,stages[i][1],19)+text(x+20,276,stages[i][2],15,'#c7bcae')+text(x+20,302,stages[i][3],15,'#c7bcae');
 if(i<3)b+=`<path d="M${x+280} 246H${x+300}" stroke="#e8b26a" stroke-width="2" marker-end="url(#arrow)"/>`;
}
b+=text(48,390,'World of a Memory',22,'#e8b26a')+text(48,423,'The photo-to-3D application',18,'#c7bcae')+text(458,390,'WOMPar',22,'#e8b26a')+text(458,423,'The frozen reference system',18,'#c7bcae')+text(858,390,'WOMetrics',22,'#e8b26a')+text(858,423,'The evaluation framework',18,'#c7bcae');
b+=text(48,479,'AI infers unseen surfaces. Explore new views and inspect the saved measurements.',17,'#a99d8d');
await writeFile(new URL('wom-pipeline.svg',out),svg('WOM: from your image to an explorable 3D world','Choose a photograph, reconstruct objects and surroundings, explore the scene, and inspect WOMetrics evidence.',510,b));
const study = JSON.parse(await readFile(new URL('docs/wom-par/experiments/2026-11-04-controlled-model-study.json',root),'utf8'));
const labels=['Muse Spark 1.3','Muse Wonder 1.0','GPT-6.1 Terra','GPT-6.1 Sol'];
b = text(48,47,'WOMETRICS / CONTROLLED PLACEMENT PILOT',17,'#e8b26a','letter-spacing="2"')+text(48,103,'Similar placement. Different resource costs.',43,'#f4ede2','font-family="Georgia, serif"')+text(48,143,`${study.photographs} photos · ${study.objectCases} object cases · ${study.agentAttempts} attempts · ${study.liveApiCalls} live API calls · $${study.tokenAccountedSpendUsd.toFixed(4)} total`,20,'#c7bcae');
b+=text(48,210,'MODEL',15,'#e8b26a')+text(330,210,'SILHOUETTE IoU / 0–100%',15,'#e8b26a')+text(715,210,'COST / 36 ATTEMPTS',15,'#e8b26a')+text(1020,210,'MEDIAN TIME',15,'#e8b26a');
for(let i=0;i<study.summaries.length;i++) {
 const s=study.summaries[i],y=259+i*74;
 b+=text(48,y,labels[i],23)+`<rect x="330" y="${y-20}" width="250" height="24" rx="5" fill="#302b24"/><rect x="330" y="${y-20}" width="${250*s.photoWeightedIou}" height="24" rx="5" fill="#a9c79a"/>`+text(600,y,`${(s.photoWeightedIou*100).toFixed(2)}%`,22)+text(715,y,`$${s.totalUsd.toFixed(4)}`,25)+text(1020,y,`${s.medianWallSeconds.toFixed(2)} s`,25);
}
b+=`<path d="M48 526H1232" stroke="#65513a"/>`+text(48,566,`Shared auto-fit tool: ${(study.geometricReferences.toolIou*100).toFixed(2)}% IoU without language-model calls.`,22,'#a9c79a')+text(48,606,'Equal weights per photo. All models completed 36/36 attempts. Holm-adjusted p = 1.0 for both planned pairs.',18,'#c7bcae')+text(48,639,'Existing assets; four independent photos. Timing excludes world generation. Global WOMPar: Not ranked.',18,'#c7bcae');
await writeFile(new URL('wom-study.svg',out),svg('WOM controlled placement study: quality, cost and latency','Four models achieve 75.28 to 75.47 percent photo-weighted silhouette IoU. Read the linked study for protocol, results and limitations.',672,b));
const saved = JSON.parse(await readFile(new URL('demo/object-split/assets/data.json',root),'utf8'));
b = text(48,47,'WOMETRICS / SAVED OBJECT-SPLIT EXPERIMENT',17,'#e8b26a','letter-spacing="2"') + text(48,101,'Keep the face. Inspect the tradeoff.',43,'#f4ede2','font-family="Georgia, serif"');
const views = [['face-photo.webp','Source photograph'],['face-one.webp','One 3D object'],['face-eyes.webp','Split + eye correction']];
for (let i=0;i<views.length;i++) {
  const data = await readFile(new URL('demo/object-split/assets/img/'+views[i][0],root));
  const x=48+i*402;
  b+=box(x,136,380,282)+`<image x="${x+10}" y="146" width="360" height="230" preserveAspectRatio="xMidYMid meet" href="data:image/webp;base64,${data.toString('base64')}"/>`+text(x+18,401,views[i][1],20);
}
b+=text(48,466,`Figure colour error: ${saved.figureError.one.toFixed(2)} → ${saved.figureError.eyes.toFixed(2)} / 255`,23,'#a9c79a')+text(48,509,`Side-view gap pixels at ${saved.sideGaps.angle}°: ${saved.sideGaps.one.toLocaleString('en-US')} → ${saved.sideGaps.split.toLocaleString('en-US')} (worse)`,23,'#f0b29a')+text(48,551,'One photograph, scripted case. Source-view detail improves while alternate-view gaps increase.',18,'#c7bcae');
await writeFile(new URL('wom-face-evidence.svg',out),svg('Source photograph, one-object reconstruction and split reconstruction','Actual saved renders from one scripted experiment. Figure colour error decreases from 26.17 to 18.47 out of 255, but side-view gaps increase from 926 to 2055 pixels at 40 degrees.',584,b));
console.log(`Built vector infographics in ${fileURLToPath(out)}`);
