// agent 回复的 Markdown → HTML。原始 HTML 一律转义，链接只放行 http(s)，避免会话内容在手机页里执行脚本
import { Marked, type Tokens } from 'marked'

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

const md = new Marked({ gfm: true, breaks: true })

md.use({
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.text)
    },
    link(token: Tokens.Link): string {
      const text = this.parser.parseInline(token.tokens)
      if (!/^https?:\/\//i.test(token.href)) {
        return text
      }
      return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`
    },
    image(token: Tokens.Image): string {
      return escapeHtml(token.text || token.href)
    }
  }
})

export function renderMarkdown(src: string): string {
  return md.parse(src, { async: false })
}
