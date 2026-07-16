import { z } from 'zod';

const auth = {
  cookies_file: z.string().optional().describe('Local EditThisCookie JSON path; defaults to AYOA_COOKIES_FILE.'),
};

export const TOOL_DEFINITIONS = [
  {
    name: 'create_mindmap',
    description: 'Create a new Ayoa mind map through the authenticated Ayoa UI.',
    inputSchema: { name: z.string().min(1).describe('Name of the new mind map.'), ...auth },
    operation: 'create_mindmap',
  },
  {
    name: 'list_mindmaps',
    description: 'List mind maps visible in the authenticated Ayoa dashboard, optionally filtered by title.',
    inputSchema: { query: z.string().optional().describe('Optional title filter.'), ...auth },
    operation: 'list_mindmaps',
  },
  {
    name: 'get_mindmap',
    description: 'Open an Ayoa mind map and return its visible metadata and a bounded text snapshot.',
    inputSchema: { mindmap_id: z.string().min(1).describe('Ayoa mind map UUID.'), ...auth },
    operation: 'get_mindmap',
  },
  {
    name: 'import_opml',
    description: 'Import an OPML file into a new Ayoa mind map via the validated Ayoa v2 import API.',
    inputSchema: { opml_file: z.string().min(1).describe('Local OPML file path.'), name: z.string().optional().describe('Optional map title override.'), ...auth },
    operation: 'import_opml',
  },
  {
    name: 'list_presenter_slides',
    description: 'Open the Ayoa Presenter panel and list its slides for a mind map.',
    inputSchema: { target: z.string().url().describe('Ayoa mind map URL.'), ...auth },
    operation: 'list_presenter_slides',
  },
  {
    name: 'prepare_presenter',
    description: 'Prepare an Ayoa Presenter deck and auto-create slides when the deck is empty.',
    inputSchema: { target: z.string().url().describe('Ayoa mind map URL.'), ...auth },
    operation: 'prepare_presenter',
  },
  {
    name: 'capture_slides',
    description: 'Capture settled Ayoa presentation slides as PNG files.',
    inputSchema: { target: z.string().url().describe('Ayoa mind map URL.'), output_dir: z.string().optional(), from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional(), wait_ms: z.number().int().min(0).optional(), ...auth },
    operation: 'capture_slides',
  },
  {
    name: 'make_video',
    description: 'Encode slide PNGs into an H.264 MP4 using FFmpeg.',
    inputSchema: { input_dir: z.string().min(1).describe('Directory with slide-*.png files.'), output_file: z.string().optional(), fps: z.string().optional(), crf: z.number().int().min(0).max(51).optional() },
    operation: 'make_video',
  },
];

export function toolNames() {
  return TOOL_DEFINITIONS.map((tool) => tool.name);
}
