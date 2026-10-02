import {Config} from '@remotion/cli/config';
Config.setBrowserExecutable(process.env.NARRATIVE_BROWSER || '/usr/bin/chromium');
Config.setConcurrency(1);
Config.setCodec('h264');
Config.setPixelFormat('yuv420p');
