import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Oddy',
    description: 'An AI navigator for Microsoft Dataverse and model-driven apps.',
    version: '0.1.0',
    minimum_chrome_version: '116',
    permissions: ['storage', 'sidePanel', 'tabs', 'scripting'],
    host_permissions: [
      'https://*.dynamics.com/*',
      'https://*.powerapps.com/*',
      'https://*.openai.azure.com/*',
      'https://*.services.ai.azure.com/*',
      'https://*.cognitiveservices.azure.com/*'
    ],
    icons: {
      16: 'icons/16.png',
      32: 'icons/32.png',
      48: 'icons/48.png',
      128: 'icons/128.png'
    },
    side_panel: {
      default_path: 'sidepanel.html'
    },
    action: {
      default_title: 'Open Oddy',
      default_icon: {
        16: 'icons/16.png',
        32: 'icons/32.png',
        48: 'icons/48.png',
        128: 'icons/128.png'
      }
    }
  }
});
