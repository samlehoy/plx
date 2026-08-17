export type CliOptions = {
  urls: string[];
  target: string | null;
  dryRun: boolean;
  output: string;
  help: boolean;
};

export const HELP_TEXT = `plx — playlist converter

Usage:
  plx                                    interactive menu
  plx --url <LINK> --to <PROVIDER>       convert a playlist into PROVIDER

The source provider is inferred from the link, so you only name the target.

Options:
  -u, --url <LINK>        playlist URL, URI, or ID (repeatable)
  -t, --to <PROVIDER>     target provider: spotify | deezer | ytmusic (required)
  -o, --output <file>     CSV report path (default: conversion_report.csv)
  -d, --dry-run           match only; do not create or modify any playlist
  -h, --help              show this help

Examples:
  plx --url https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M --to deezer
  plx --url https://www.deezer.com/playlist/1234567890 --to ytmusic
  plx --url https://music.youtube.com/playlist?list=PL... --to spotify
  plx --url https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M --to deezer --dry-run
  plx
`;

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { urls: [], target: null, dryRun: false, output: 'conversion_report.csv', help: false };
  const takeValue = (i: number, inline: string | undefined): { value: string | undefined; next: number } =>
    inline !== undefined ? { value: inline, next: i + 1 } : { value: argv[i + 1], next: i + 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--dry-run' || arg === '-d') { options.dryRun = true; continue; }
    const flagMatch = arg.match(/^(--\w[\w-]*|-\w)=(.+)$/);
    const flag = flagMatch ? flagMatch[1] : arg;
    const inline = flagMatch ? flagMatch[2] : undefined;
    if (flag === '--url' || flag === '-u') { const { value, next } = takeValue(i, inline); if (value) options.urls.push(value); i = next - 1; continue; }
    if (flag === '--to' || flag === '-t') { const { value, next } = takeValue(i, inline); if (value) options.target = value; i = next - 1; continue; }
    if (flag === '--output' || flag === '-o') { const { value, next } = takeValue(i, inline); if (value) options.output = value; i = next - 1; continue; }
    if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
    throw new Error(`Unexpected argument: ${arg}`);
  }
  return options;
}
