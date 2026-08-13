This is a new [**React Native**](https://reactnative.dev) project, bootstrapped using [`@react-native-community/cli`](https://github.com/react-native-community/cli), with macOS support added via [`react-native-macos`](https://microsoft.github.io/react-native-macos/).

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android, iOS, or macOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

### macOS

Like iOS, the macOS target needs its CocoaPods dependencies installed (this only needs to be run on first clone or after updating native deps). The macOS Podfile lives in the `macos/` folder, so point `pod install` at it:

```sh
bundle exec pod install --project-directory=macos
```

Then, with Metro still running from Step 1, build and launch the macOS app:

```sh
npx react-native run-macos
```

The first run may take a while since it involves building the entire project and all dependencies.

Alternatively, you can open the workspace directly in Xcode and run it from there:

```sh
xed -b macos
```

Or build without launching:

```sh
npx react-native build-macos
```

> **Note**: Be sure to keep the `react-native` and `react-native-macos` versions on the same minor version to avoid compatibility issues. For more details, see the [react-native-macos Getting Started guide](https://microsoft.github.io/react-native-macos/docs/getting-started).

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, macOS app window, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.
- **macOS**: Select **"Reload"** from the **Dev Menu**, accessed via <kbd>Cmd ⌘</kbd> + <kbd>D</kbd> in the app window.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
- [react-native-macos Getting Started](https://microsoft.github.io/react-native-macos/docs/getting-started) - setup and running instructions for the macOS target.
- [`microsoft/react-native-macos`](https://github.com/microsoft/react-native-macos) - the Open Source; GitHub **repository** for React Native macOS.
