// electron-builder v26 configuration. Public builds require the signed release gate.
const signed = process.env.WORKROOM_SIGNED_RELEASE === '1';
const { version } = require('./package.json');
module.exports = {
  appId: 'app.workwebgpt.desktop',
  productName: 'WWG',
  directories: { output: `release/${version}` },
  artifactName: 'WWG-${version}-${arch}' + (signed ? '' : '-preview') + '.${ext}',
  asar: true,
  npmRebuild: false,
  compression: 'normal',
  files: ['out/**/*', 'package.json', 'LICENSE'],
  forceCodeSigning: signed,
  electronFuses: {
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: !signed,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false
  },
  mac: {
    category: 'public.app-category.developer-tools',
    target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
    icon: 'build/icon.icns',
    identity: signed ? undefined : '-',
    hardenedRuntime: signed,
    notarize: signed,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    darkModeSupport: false
  },
  win: {
    target: [{ target: 'portable', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }],
    artifactName: 'WWG-${version}-${arch}-portable-preview.${ext}',
    icon: 'build/icon.ico',
    requestedExecutionLevel: 'asInvoker'
  },
  portable: { requestExecutionLevel: 'user', unpackDirName: false },
  dmg: { sign: signed, title: 'WWG ${version}', contents: [{ x: 150, y: 180 }, { x: 430, y: 180, type: 'link', path: '/Applications' }] },
  publish: null
};
