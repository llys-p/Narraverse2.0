// Read projection only: preserve prose and headings without modifying the Markdown source.
export function parseOverview(markdown: string) {
  const draft = { title: '', lede: '', blocks: [] as { heading: string; body: string }[] }
  const preamble: string[] = []
  let current: { heading: string; lines: string[] } | null = null
  let fence: { char: string; length: number } | null = null
  const flush = () => {
    if (current) draft.blocks.push({ heading: current.heading, body: current.lines.join('\n').trim() })
  }
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (marker) {
      const char = marker[1][0]
      if (!fence) fence = { char, length: marker[1].length }
      else if (char === fence.char && marker[1].length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = null
      ;(current ? current.lines : preamble).push(line)
      continue
    }
    const section = !fence && line.match(/^##\s+(.+?)\s*#*\s*$/)
    if (section) {
      flush()
      current = { heading: section[1], lines: [] }
    } else if (!fence && !current && !draft.title && /^#\s+/.test(line)) {
      draft.title = line.replace(/^#\s+/, '').trim()
    } else {
      ;(current ? current.lines : preamble).push(line)
    }
  }
  flush()
  draft.lede = preamble.join('\n').trim()
  return draft
}
