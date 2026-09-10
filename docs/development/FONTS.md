# Font Setup — Manrope

Download these 4 weights from Google Fonts (https://fonts.google.com/specimen/Manrope):

| File name (exact)     | Weight |
| --------------------- | ------ |
| Manrope-Light.ttf     | 300    |
| Manrope-Regular.ttf   | 400    |
| Manrope-Medium.ttf    | 500    |
| Manrope-SemiBold.ttf  | 600    |
| Manrope-Bold.ttf      | 700    |
| Manrope-ExtraBold.ttf | 800    |

Place all files in: `src/assets/fonts/`

Then link them:

```bash
npx react-native-asset
```

This reads `react-native.config.js` and copies the fonts into:

- `android/app/src/main/assets/fonts/`
- `ios/BravoSecure/` (Info.plist updated automatically)

After linking, rebuild the app:

```bash
# iOS
cd ios && pod install && cd ..
npx react-native run-ios

# Android
npx react-native run-android
```
