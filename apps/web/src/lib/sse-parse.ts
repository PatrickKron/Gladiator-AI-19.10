/**
 * Inkrementeller SSE-Parser (für fetch + ReadableStream, weil EventSource
 * keinen Authorization-Header kann). Chunks dürfen Events beliebig zerteilen.
 */
export function createSseParser(onEvent: (event: string, data: unknown) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      if (dataLines.length === 0) continue;
      try {
        onEvent(event, JSON.parse(dataLines.join('\n')));
      } catch {
        // kaputtes Event überspringen — der Stream bleibt nutzbar
      }
    }
  };
}
