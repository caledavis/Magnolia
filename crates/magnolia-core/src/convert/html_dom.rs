//! A small, forgiving HTML parser for the converters' own output (the
//! Word / RTF / ODT → HTML step), so it can be typeset. It handles what
//! those converters write: nested elements, quoted attributes, void
//! elements (`<br>`, `<img>`), self-closing tags and character references.
//! It isn't a general HTML5 parser.

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Element(Element),
    Text(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Element {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
}

impl Element {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    /// One declaration of the `style` attribute, e.g. `style("color")`.
    pub fn style(&self, prop: &str) -> Option<String> {
        let css = self.attr("style")?;
        css.split(';').find_map(|decl| {
            let (k, v) = decl.split_once(':')?;
            (k.trim().eq_ignore_ascii_case(prop)).then(|| v.trim().to_string())
        })
    }
}

const VOID: &[&str] = &["br", "img", "hr", "meta", "link", "input", "col", "wbr"];

/// Parse `html` into its top-level nodes.
pub fn parse(html: &str) -> Vec<Node> {
    // The open elements, innermost last; the root is a nameless element.
    let mut stack: Vec<Element> = vec![Element { name: String::new(), attrs: vec![], children: vec![] }];
    let mut rest = html;
    while !rest.is_empty() {
        let Some(lt) = rest.find('<') else {
            push_text(&mut stack, rest);
            break;
        };
        if lt > 0 {
            push_text(&mut stack, &rest[..lt]);
        }
        rest = &rest[lt..];
        if let Some(after) = rest.strip_prefix("<!--") {
            rest = after.find("-->").map(|i| &after[i + 3..]).unwrap_or("");
        } else if rest.starts_with("<!") || rest.starts_with("<?") {
            rest = rest.find('>').map(|i| &rest[i + 1..]).unwrap_or("");
        } else if let Some(after) = rest.strip_prefix("</") {
            let end = after.find('>').unwrap_or(after.len());
            let name = after[..end].trim().to_ascii_lowercase();
            rest = after.get(end + 1..).unwrap_or("");
            close(&mut stack, &name);
        } else if rest[1..].starts_with(|c: char| c.is_ascii_alphabetic()) {
            let (el, self_closing, after) = parse_tag(&rest[1..]);
            rest = after;
            if self_closing || VOID.contains(&el.name.as_str()) {
                stack.last_mut().unwrap().children.push(Node::Element(el));
            } else {
                stack.push(el);
            }
        } else {
            // A lone '<' is text.
            push_text(&mut stack, "<");
            rest = &rest[1..];
        }
    }
    while stack.len() > 1 {
        let el = stack.pop().unwrap();
        stack.last_mut().unwrap().children.push(Node::Element(el));
    }
    stack.pop().unwrap().children
}

fn push_text(stack: &mut [Element], raw: &str) {
    let text = decode_entities(raw);
    let children = &mut stack.last_mut().unwrap().children;
    if let Some(Node::Text(prev)) = children.last_mut() {
        prev.push_str(&text);
    } else {
        children.push(Node::Text(text));
    }
}

/// Close the innermost open `name` (and anything left open inside it); an
/// end tag with no open element is ignored.
fn close(stack: &mut Vec<Element>, name: &str) {
    let Some(i) = stack.iter().rposition(|e| e.name == name) else { return };
    if i == 0 {
        return;
    }
    while stack.len() > i {
        let el = stack.pop().unwrap();
        stack.last_mut().unwrap().children.push(Node::Element(el));
    }
}

/// Parse a start tag after its '<': the element, whether it closed itself
/// (`/>`), and the text after its '>'.
fn parse_tag(s: &str) -> (Element, bool, &str) {
    let name_end = s.find(|c: char| c.is_whitespace() || c == '>' || c == '/').unwrap_or(s.len());
    let name = s[..name_end].to_ascii_lowercase();
    let mut attrs = Vec::new();
    let mut rest = &s[name_end..];
    let mut self_closing = false;
    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        if let Some(after) = rest.strip_prefix("/>") {
            self_closing = true;
            rest = after;
            break;
        }
        if let Some(after) = rest.strip_prefix('>') {
            rest = after;
            break;
        }
        if let Some(after) = rest.strip_prefix('/') {
            rest = after;
            continue;
        }
        let key_end = rest
            .find(|c: char| c.is_whitespace() || c == '=' || c == '>' || c == '/')
            .unwrap_or(rest.len());
        let key = rest[..key_end].to_ascii_lowercase();
        rest = rest[key_end..].trim_start();
        let mut value = String::new();
        if let Some(after) = rest.strip_prefix('=') {
            let after = after.trim_start();
            if let Some(q) = after.chars().next().filter(|c| *c == '"' || *c == '\'') {
                let body = &after[1..];
                let end = body.find(q).unwrap_or(body.len());
                value = decode_entities(&body[..end]);
                rest = body.get(end + 1..).unwrap_or("");
            } else {
                let end = after.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(after.len());
                value = decode_entities(&after[..end]);
                rest = &after[end..];
            }
        }
        if !key.is_empty() {
            attrs.push((key, value));
        } else if !rest.is_empty() {
            // Skip a character we can't read as an attribute.
            let mut chars = rest.chars();
            chars.next();
            rest = chars.as_str();
        }
    }
    (Element { name, attrs, children: vec![] }, self_closing, rest)
}

/// Decode character references: the named ones the converters write, plus
/// numeric ones.
pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let semi = rest[1..].find(';').map(|j| j + 1).filter(|j| *j <= 10);
        let decoded = semi.and_then(|j| {
            let name = &rest[1..j];
            let c = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some('\u{a0}'),
                _ => name.strip_prefix('#').and_then(|n| {
                    let code = match n.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok(),
                        None => n.parse().ok(),
                    };
                    code.and_then(char::from_u32)
                }),
            };
            c.map(|c| (c, j))
        });
        match decoded {
            Some((c, j)) => {
                out.push(c);
                rest = &rest[j + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(n: &Node) -> &Element {
        match n {
            Node::Element(e) => e,
            _ => panic!("not an element: {n:?}"),
        }
    }

    #[test]
    fn parses_nesting_void_and_entities() {
        let nodes = parse("<p style=\"text-align:right\">A &amp; B<br>C <img src='x.png' /><strong>D</strong></p><p>&#1605;&nbsp;</p>");
        assert_eq!(nodes.len(), 2);
        let p = el(&nodes[0]);
        assert_eq!(p.style("text-align").as_deref(), Some("right"));
        assert_eq!(p.children[0], Node::Text("A & B".into()));
        assert_eq!(el(&p.children[1]).name, "br");
        assert_eq!(el(&p.children[3]).attr("src"), Some("x.png"));
        assert_eq!(el(&p.children[4]).children[0], Node::Text("D".into()));
        assert_eq!(el(&nodes[1]).children[0], Node::Text("م\u{a0}".into()));
    }

    #[test]
    fn tolerates_stray_end_tags_and_unclosed_elements() {
        let nodes = parse("<ul><li>a</span>b<li>c</ul>tail & more");
        let ul = el(&nodes[0]);
        assert_eq!(ul.name, "ul");
        assert_eq!(nodes[1], Node::Text("tail & more".into()));
    }
}
