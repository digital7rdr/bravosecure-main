/**
 * Expo config plugin — injects the BravoFrameCryptor iOS native module
 * (B-111-B) into the generated Xcode project on every prebuild.
 *
 * ios/ is gitignored and regenerated, so the checked-in sources live in
 * native/ios/ and are (1) copied into ios/<project>/ and (2) registered in
 * the app target's Sources build phase. Idempotent: re-running prebuild
 * refreshes the copies and skips already-registered files.
 *
 * The module itself compiles against the LiveKitWebRTC framework pulled in
 * by the @livekit/react-native-webrtc npm alias — see
 * docs/handoffs/IOS_FRAMECRYPTOR_B111B_IMPLEMENTATION_2026-07-18.md.
 */
const {withXcodeProject, IOSConfig} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SOURCES = ['BravoFrameCryptor.swift', 'BravoFrameCryptor.m'];

module.exports = function withBravoFrameCryptor(config) {
  return withXcodeProject(config, cfg => {
    const projectRoot = cfg.modRequest.projectRoot;
    const projectName = cfg.modRequest.projectName;
    if (!projectName) {
      console.warn('[withBravoFrameCryptor] no projectName — skipping (prebuild anomaly)');
      return cfg;
    }
    const srcDir = path.join(projectRoot, 'native', 'ios');
    const destDir = path.join(cfg.modRequest.platformProjectRoot, projectName);
    const project = cfg.modResults;

    for (const file of SOURCES) {
      const src = path.join(srcDir, file);
      if (!fs.existsSync(src)) {
        console.warn(
          `[withBravoFrameCryptor] missing source ${src} — FrameCryptor module NOT installed`,
        );
        continue;
      }
      fs.copyFileSync(src, path.join(destDir, file));
      const relative = `${projectName}/${file}`;
      if (!project.hasFile(relative)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath: relative,
          groupName: projectName,
          project,
        });
      }
    }
    return cfg;
  });
};
