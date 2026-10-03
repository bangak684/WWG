import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function prepareRelease(root) {
  const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(pkg.version))throw new Error('Invalid release version');
  const output=path.join(root,'release',pkg.version);
  await fs.mkdir(output,{recursive:true});
  const notes=path.join(output,'RELEASE.md');
  try {
    const readme=await fs.readFile(path.join(root,'README.md'),'utf8');
    const features=readme.match(/## 기능\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim();
    if(!features)throw new Error('README features are missing');
    await fs.writeFile(notes,`# WWG ${pkg.version}\n\nworkwebGPT — 웹 ChatGPT를 내 컴퓨터에 연결해 파일과 명령을 실행하는 앱입니다.\n\n## 기능\n\n${features}\n\n## 사용방법\n\n1. macOS는 DMG로 WWG를 설치합니다. Windows는 무설치형 EXE를 바로 실행하거나 ZIP을 풀고 WWG.exe를 실행합니다.\n2. 상단의 **접근 폴더**에서 사용할 폴더를 선택합니다. 여러 폴더를 선택할 수 있습니다. 연결된 ChatGPT에 접근 가능한 프로젝트 목록을 확인해 달라고 요청할 수 있습니다.\n3. **ChatGPT 연결**에서 터널을 연결합니다. API 키는 저장하지 않으므로 앱을 실행할 때마다 다시 입력합니다. 웹 ChatGPT의 **+ → 맞춤형 MCP 서버 만들기**로 WWG를 등록하고 **Connection → Tunnel**에 같은 터널을 지정해 생성을 완료합니다.\n4. 웹 ChatGPT 대화에서 **@WWG**를 입력하고 WWG 플러그인을 선택해 활성화한 뒤 작업을 요청합니다.\n   여러 단계의 요청은 작업으로 묶어 달라고 요청할 수 있습니다. **실행 로그**에서 작업을 펼쳐 결과를 확인하거나 **작업 중지**를 선택합니다. **요청 완료**는 현재까지 등록된 요청의 성공을 뜻합니다. 새 대화에서 **@WWG**를 선택하고 **“지난 작업 이어서 해줘”**라고 요청하면 저장된 작업 기억을 불러와 이어갈 수 있습니다.\n5. 수동승인이 필요한 요청은 **실행 로그**에서 **승인 후 실행** 또는 **거절**로 결정합니다.\n6. 필요하면 **자동승인 켜기**를 선택하고, **실행 로그**에서 받은 요청과 결과를 확인합니다. .env 파일은 항상 차단됩니다.\n`,{flag:'wx'});
  } catch(error) {if(error.code!=='EEXIST')throw error;}
  return { output, version:pkg.version, pkg };
}

export async function writeReleaseManifest(root,target) {
  const { output, version, pkg }=await prepareRelease(root);
  const prefix=`WWG-${version}-`;
  const files=[];
  for(const file of (await fs.readdir(output)).filter(name=>name.startsWith(prefix)&&/^(?:arm64(?:-preview)?\.(?:dmg|zip)|x64-portable-preview\.(?:exe|zip))$/.test(name.slice(prefix.length))).sort()) {
    const hash=createHash('sha256');
    for await(const chunk of createReadStream(path.join(output,file)))hash.update(chunk);
    files.push({file,bytes:(await fs.stat(path.join(output,file))).size,sha256:hash.digest('hex')});
  }
  const expected=target.platform==='win32'?['exe','zip']:['dmg','zip'];
  const suffix=target.platform==='win32'?'-portable-preview':target.signing==='Developer ID'?'':'-preview';
  for(const extension of expected)if(!files.some(file=>file.file===`${prefix}${target.arch}${suffix}.${extension}`))throw new Error(`Missing ${target.platform} ${extension} package`);
  const manifestPath=path.join(output,'release-manifest.json');
  const previous=await fs.readFile(manifestPath,'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT')return {};throw error;});
  const platforms={...(previous.platforms??{}),[`${target.platform}-${target.arch}`]:target};
  for(const key of Object.keys(platforms))if(!files.some(file=>file.file.includes(`-${platforms[key].arch}`)))delete platforms[key];
  const manifest={name:'WWG',version,electron:pkg.devDependencies.electron,published:false,platforms,files};
  await fs.writeFile(path.join(output,'SHA256SUMS.txt'),files.map(file=>`${file.sha256}  ${file.file}`).join('\n')+'\n');
  await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
