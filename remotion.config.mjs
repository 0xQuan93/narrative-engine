import {Config} from '@remotion/cli/config';
import {resolveBrowserExecutable} from './src/browser-executable.mjs';
Config.setBrowserExecutable(resolveBrowserExecutable());
Config.setConcurrency(1);
Config.setCodec('h264');
Config.setPixelFormat('yuv420p');
