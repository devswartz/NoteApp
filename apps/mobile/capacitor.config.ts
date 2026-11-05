// Capacitor shell for iPhone and Android. See docs/MOBILE.md.
//
// The built web app (dist/ at the repo root) is bundled into the app, so it
// starts instantly and opens offline; it talks to the server at VITE_API_URL,
// which `npm run mobile:sync` sets from MOBILE_SERVER_URL (default
// https://notes.devswartz.com).
//
// Live reload during development: CAP_SERVER_URL=http://<your-lan-ip>:5173 npm run mobile:sync
import type { CapacitorConfig } from '@capacitor/cli';
import { APP_NAME } from '../../shared/config.ts';

/** Bundle id / application id. Changing it makes a new app in the stores. */
export const APP_ID = 'com.devswartz.noteapp';

const devServer = process.env.CAP_SERVER_URL;

const config: CapacitorConfig = {
  appId: APP_ID,
  appName: APP_NAME,
  webDir: '../../dist',
  backgroundColor: '#ffffff',
  server: devServer ? { url: devServer, cleartext: devServer.startsWith('http:') } : { androidScheme: 'https' },
  ios: {
    // Let the page draw under the status bar / home indicator; the web layout
    // pads itself with env(safe-area-inset-*).
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false, // hidden by the adapter once the first screen has rendered
      launchShowDuration: 3000,
      backgroundColor: '#ffffff',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
    },
    Keyboard: {
      // Resize the web view (not just the body) so bottom bars sit above the keyboard.
      resize: 'native',
      resizeOnFullScreen: true,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_notify',
      iconColor: '#4f46e5',
    },
    // Android draws edge to edge; with viewport-fit=cover (index.html) the
    // web view gets real env(safe-area-inset-*) values, as on iOS.
    SystemBars: {
      insetsHandling: 'native',
      initialViewportFitValueHint: 'cover',
    },
  },
};

export default config;
