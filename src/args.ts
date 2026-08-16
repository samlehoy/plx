export type CliOptions = {
  urls: string[];
  dryRun: boolean;
  output: string;
  help: boolean;
};

export const HELP_TEXT = `plx — Spotify ⇄ Deezer playlist converter

Usage:
  plx                              interactive menu (both directions)
  plx --url <URL|ID> [--url ...]   convert Spotify playlist(s) to Deezer

Options:
  -u, --url <URL|ID>      Spotify playlist URL, URI, or ID (repeatable)
  -o, --output <file>     CSV report path (default: conversion_report.csv)
  -d, --dry-run           match only; do not create playlists
  -h, --help              show this help

Examples:
  plx --url https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M --dry-run
  plx
`;

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { urls: [], dryRun: false, output: 'conversion_report.csv', help: false };
  const takeValue = (flag: string, i: number, inline: string | undefined): { value: string | undefined; next: number } =>
    inline !== undefined ? { value: inline, next: i + 1 } : { value: argv[i + 1], next: i + 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--dry-run' || arg === '-d') { options.dryRun = true; continue; }
    const flagMatch = arg.match(/^(--\w+|\w)=(.+)$/);
    const flag = flagMatch ? flagMatch[1] : arg;
    const inline = flagMatch ? flagMatch[2] : undefined;
    if (flag === '--url' || flag === '-u') { const { value, next } = takeValue('--url', i, inline); if (value) options.urls.push(value); i = next - 1; continue; }
    if (flag === '--output' || flag === '-o') { const { value, next } = takeValue('--output', i, inline); if (value) options.output = value; i = next - 1; continue; }
    if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
    throw new Error(`Unexpected argument: ${arg}`);
  }
  return options;
}
