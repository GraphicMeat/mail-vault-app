// Conditional Vitest source overlay for four old-JS caller traces.
// Archives are captured before S3 port; this plugin serves their exact bytes
// to Vite without editing the current checkout. Root supplies a fresh task copy.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root=process.env.MV_UNREAD_ROOT || process.cwd();
const manifestPath=process.env.MV_UNREAD_O_ARCHIVE_MANIFEST;
const archiveDir=process.env.MV_UNREAD_O_ARCHIVE_DIR;
if(!manifestPath || !archiveDir) throw Error('Archived O replay needs manifest and archive dir');
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
if(sha(fs.readFileSync(path.join(root,'vitest.config.js')))!==manifest.harnessConfigSha256)
  throw Error('Changed Vitest capture configuration');
for(const [relative,expected] of Object.entries(manifest.tests||{})){
  if(sha(fs.readFileSync(path.join(root,relative)))!==expected)
    throw Error(`Changed O caller capture test ${relative}`);
}
const originals=new Map();
for(const [relative,expected] of Object.entries(manifest.files)){
  const encoded=fs.readFileSync(path.join(archiveDir,relative.replaceAll('/','__')+'.base64'),'ascii').trim();
  const bytes=Buffer.from(encoded,'base64');
  if(sha(bytes)!==expected) throw Error(`Changed archived O source ${relative}`);
  originals.set(relative,bytes.toString('utf8'));
}
const tests=(process.env.MV_UNREAD_O_TEST_FILES || '').split(';').filter(Boolean);
if(tests.length!==2) throw Error('Expected the two exact O caller capture tests');
const {default:base}=await import(pathToFileURL(path.join(root,'vitest.config.js')).href);
const archivedId=(file)=>{
  const relative=path.relative(root,file).split(path.sep).join('/');
  return [relative,`${relative}.js`,`${relative}.jsx`,`${relative}.json`,`${relative}/index.js`]
    .find(candidate=>originals.has(candidate));
};
export default {
  ...base,
  root,
  plugins:[{name:'frozen-unread-o-callers',enforce:'pre',resolveId(source,importer){
    if(!importer || !path.isAbsolute(importer.split('?')[0]) || !source.startsWith('.')) return null;
    const candidate=archivedId(path.resolve(path.dirname(importer.split('?')[0]),source));
    return candidate ? path.join(root,candidate) : null;
  },load(id){
    const clean=id.split('?')[0];
    if(!path.isAbsolute(clean)) return null;
    const relative=path.relative(root,clean).split(path.sep).join('/');
    return originals.get(relative) ?? null;
  }},...(base.plugins||[])],
  test:{...base.test,include:tests,exclude:[],testTimeout:180000,fileParallelism:false},
};
