//! App-authored message components and cards; the validator defines what the guild server accepts.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

/// Five rows of five is the shape every client lays out for.
pub const MAX_ROWS: usize = 5;

pub const MAX_ROW_CHILDREN: usize = 5;

pub const MAX_CUSTOM_ID_CHARS: usize = 100;

pub const MAX_OPTIONS: usize = 25;

pub const MAX_LABEL_CHARS: usize = 80;
pub const MAX_PLACEHOLDER_CHARS: usize = 150;
pub const MAX_DESCRIPTION_CHARS: usize = 100;
pub const MAX_VALUE_CHARS: usize = 100;
pub const MAX_EMOJI_CHARS: usize = 64;
pub const MAX_URL_CHARS: usize = 2048;

pub const MAX_CARD_TITLE_CHARS: usize = 256;
pub const MAX_CARD_DESCRIPTION_CHARS: usize = 4096;
pub const MAX_CARD_FIELD_NAME_CHARS: usize = 256;
pub const MAX_CARD_FIELD_VALUE_CHARS: usize = 1024;
pub const MAX_CARD_FOOTER_CHARS: usize = 2048;
pub const MAX_CARD_AUTHOR_CHARS: usize = 256;

pub const MAX_CARDS: usize = 5;

/// Backstop: per-field ceilings still allow tens of KB that every history page re-serialises.
pub const MAX_COMPONENT_TEXT_CHARS: usize = 8192;

pub const MAX_MODAL_INPUTS: usize = 5;

pub const MAX_TEXT_INPUT_VALUE_CHARS: usize = 4000;


/// `Link` navigates and never reaches the server; exclusive-or with `custom_id` in `validate_components`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ButtonStyle {
    Primary,
    Secondary,
    Success,
    Danger,
    Link,
}

impl ButtonStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            ButtonStyle::Primary => "primary",
            ButtonStyle::Secondary => "secondary",
            ButtonStyle::Success => "success",
            ButtonStyle::Danger => "danger",
            ButtonStyle::Link => "link",
        }
    }

    pub fn dispatches(self) -> bool {
        !matches!(self, ButtonStyle::Link)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextInputStyle {
    Short,
    Paragraph,
}

impl TextInputStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            TextInputStyle::Short => "short",
            TextInputStyle::Paragraph => "paragraph",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectOption {
    pub label: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Component {
    Button {
        style: ButtonStyle,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        emoji: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        disabled: Option<bool>,
    },
    Select {
        custom_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
        options: Vec<SelectOption>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        disabled: Option<bool>,
    },
    /// Modals only: a `text_input` in a message is rejected.
    TextInput {
        custom_id: String,
        label: String,
        style: TextInputStyle,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        required: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
}

impl Component {
    pub fn dispatching_custom_id(&self) -> Option<&str> {
        match self {
            Component::Button { style, custom_id, .. } if style.dispatches() => {
                custom_id.as_deref()
            }
            Component::Button { .. } => None,
            Component::Select { custom_id, .. } => Some(custom_id),
            Component::TextInput { custom_id, .. } => Some(custom_id),
        }
    }

    pub fn is_disabled(&self) -> bool {
        match self {
            Component::Button { disabled, .. } => disabled.unwrap_or(false),
            Component::Select { disabled, .. } => disabled.unwrap_or(false),
            Component::TextInput { .. } => false,
        }
    }

    fn text_len(&self) -> usize {
        let count = |s: &Option<String>| s.as_ref().map(|v| v.chars().count()).unwrap_or(0);
        match self {
            Component::Button { label, emoji, custom_id, url, .. } => {
                label.chars().count() + count(emoji) + count(custom_id) + count(url)
            }
            Component::Select { custom_id, placeholder, options, .. } => {
                custom_id.chars().count()
                    + count(placeholder)
                    + options
                        .iter()
                        .map(|o| {
                            o.label.chars().count()
                                + o.value.chars().count()
                                + count(&o.description)
                                + count(&o.emoji)
                        })
                        .sum::<usize>()
            }
            Component::TextInput { custom_id, label, value, .. } => {
                custom_id.chars().count() + label.chars().count() + count(value)
            }
        }
    }
}

/// The only container, so depth is bounded at write time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TopLevel {
    ActionRow { components: Vec<Component> },
}

impl TopLevel {
    pub fn children(&self) -> &[Component] {
        match self {
            TopLevel::ActionRow { components } => components,
        }
    }
}


/// No variant carries an application-chosen URL: it would leak members' IPs to a tracker, which the camo proxy exists to prevent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CardImage {
    Media {
        origin: String,
        hash: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        height: Option<i64>,
    },
    Camo {
        camo: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        height: Option<i64>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CardField {
    pub name: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CardAuthor {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<CardImage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CardFooter {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<CardImage>,
}

/// Distinct from `embeds`: a card must not share a renderer with unfurls, or it could impersonate one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Card {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Bounded to `https:` so no `javascript:` handler gets through.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colour: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<CardAuthor>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<CardField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<CardImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<CardImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub footer: Option<CardFooter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
}


#[derive(Debug, Clone, PartialEq)]
pub enum InvalidTree {
    TooManyRows(usize),
    TooManyChildren(usize),
    WrongPlace(&'static str),
    CustomIdTooLong(usize),
    CustomIdEmpty,
    DuplicateCustomId(String),
    ButtonIdentity(&'static str),
    LinkUrlInvalid(String),
    TextTooLong { field: &'static str, max: usize },
    TooManyOptions(usize),
    NoOptions,
    SelectRange(&'static str),
    TotalTextTooLong(usize),
    TooManyCards(usize),
    TooManyFields(usize),
    ColourOutOfRange(u32),
    CardUrlInvalid(String),
    EmptyCard,
}

impl std::fmt::Display for InvalidTree {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InvalidTree::TooManyRows(n) => {
                write!(f, "a message may carry {MAX_ROWS} action rows, not {n}")
            }
            InvalidTree::TooManyChildren(n) => {
                write!(f, "an action row may carry {MAX_ROW_CHILDREN} components, not {n}")
            }
            InvalidTree::WrongPlace(what) => write!(f, "{what}"),
            InvalidTree::CustomIdTooLong(n) => {
                write!(f, "custom_id is limited to {MAX_CUSTOM_ID_CHARS} characters, not {n}")
            }
            InvalidTree::CustomIdEmpty => write!(f, "custom_id must not be empty"),
            InvalidTree::DuplicateCustomId(id) => {
                write!(f, "custom_id {id:?} appears more than once in this message")
            }
            InvalidTree::ButtonIdentity(what) => write!(f, "{what}"),
            InvalidTree::LinkUrlInvalid(url) => {
                write!(f, "a link button needs an https url, not {url:?}")
            }
            InvalidTree::TextTooLong { field, max } => {
                write!(f, "{field} is limited to {max} characters")
            }
            InvalidTree::TooManyOptions(n) => {
                write!(f, "a select may carry {MAX_OPTIONS} options, not {n}")
            }
            InvalidTree::NoOptions => write!(f, "a select needs at least one option"),
            InvalidTree::SelectRange(what) => write!(f, "{what}"),
            InvalidTree::TotalTextTooLong(n) => write!(
                f,
                "components carry {n} characters of text, over the {MAX_COMPONENT_TEXT_CHARS} limit"
            ),
            InvalidTree::TooManyCards(n) => {
                write!(f, "a message may carry {MAX_CARDS} cards, not {n}")
            }
            InvalidTree::TooManyFields(n) => {
                write!(f, "a card may carry {MAX_OPTIONS} fields, not {n}")
            }
            InvalidTree::ColourOutOfRange(c) => {
                write!(f, "colour {c} is not an RGB value in 0x000000..=0xffffff")
            }
            InvalidTree::CardUrlInvalid(url) => {
                write!(f, "a card url must be https, not {url:?}")
            }
            InvalidTree::EmptyCard => {
                write!(f, "a card needs at least a title, a description, a field or an image")
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeContext {
    Message,
    Modal,
}

pub fn validate_components(
    rows: &[TopLevel],
    context: TreeContext,
) -> Result<(), InvalidTree> {
    let max_rows = match context {
        TreeContext::Message => MAX_ROWS,
        // A modal is one column of fields; the row is kept so both trees deserialise as one type.
        TreeContext::Modal => MAX_MODAL_INPUTS,
    };
    if rows.len() > max_rows {
        return Err(InvalidTree::TooManyRows(rows.len()));
    }

    let mut seen: HashSet<&str> = HashSet::new();
    let mut total_text = 0usize;

    for row in rows {
        let children = row.children();
        if children.len() > MAX_ROW_CHILDREN {
            return Err(InvalidTree::TooManyChildren(children.len()));
        }
        for child in children {
            total_text += child.text_len();
            validate_component(child, context)?;
            // Per message, not per row: a press quotes one `custom_id` and must resolve to one component.
            if let Some(id) = child.dispatching_custom_id() {
                if !seen.insert(id) {
                    return Err(InvalidTree::DuplicateCustomId(id.to_string()));
                }
            }
        }
    }

    if total_text > MAX_COMPONENT_TEXT_CHARS {
        return Err(InvalidTree::TotalTextTooLong(total_text));
    }
    Ok(())
}

fn validate_component(component: &Component, context: TreeContext) -> Result<(), InvalidTree> {
    match (component, context) {
        (Component::TextInput { .. }, TreeContext::Message) => {
            return Err(InvalidTree::WrongPlace(
                "text_input belongs in a modal, not in a message's components",
            ))
        }
        (Component::Button { .. }, TreeContext::Modal)
        | (Component::Select { .. }, TreeContext::Modal) => {
            return Err(InvalidTree::WrongPlace(
                "a modal carries text_input components and nothing else",
            ))
        }
        _ => {}
    }

    match component {
        Component::Button { style, label, emoji, custom_id, url, .. } => {
            bound("label", label, MAX_LABEL_CHARS)?;
            if let Some(emoji) = emoji {
                bound("emoji", emoji, MAX_EMOJI_CHARS)?;
            }
            // The exclusive-or. A link that also carries a `custom_id` gives the client contradictory instructions.
            if style.dispatches() {
                let id = custom_id
                    .as_deref()
                    .ok_or(InvalidTree::ButtonIdentity("a non-link button needs a custom_id"))?;
                if url.is_some() {
                    return Err(InvalidTree::ButtonIdentity(
                        "only a link button may carry a url",
                    ));
                }
                bound_custom_id(id)?;
            } else {
                if custom_id.is_some() {
                    return Err(InvalidTree::ButtonIdentity(
                        "a link button must not carry a custom_id: it never dispatches",
                    ));
                }
                let url = url
                    .as_deref()
                    .ok_or(InvalidTree::ButtonIdentity("a link button needs a url"))?;
                if url.chars().count() > MAX_URL_CHARS || !is_https(url) {
                    return Err(InvalidTree::LinkUrlInvalid(truncate_for_message(url)));
                }
            }
        }
        Component::Select { custom_id, placeholder, options, min, max, .. } => {
            bound_custom_id(custom_id)?;
            if let Some(placeholder) = placeholder {
                bound("placeholder", placeholder, MAX_PLACEHOLDER_CHARS)?;
            }
            if options.is_empty() {
                return Err(InvalidTree::NoOptions);
            }
            if options.len() > MAX_OPTIONS {
                return Err(InvalidTree::TooManyOptions(options.len()));
            }
            let mut values: HashSet<&str> = HashSet::new();
            for option in options {
                bound("option label", &option.label, MAX_LABEL_CHARS)?;
                bound("option value", &option.value, MAX_VALUE_CHARS)?;
                if option.value.is_empty() {
                    return Err(InvalidTree::CustomIdEmpty);
                }
                if let Some(d) = &option.description {
                    bound("option description", d, MAX_DESCRIPTION_CHARS)?;
                }
                if let Some(e) = &option.emoji {
                    bound("option emoji", e, MAX_EMOJI_CHARS)?;
                }
                if !values.insert(&option.value) {
                    return Err(InvalidTree::DuplicateCustomId(option.value.clone()));
                }
            }
            let min = min.unwrap_or(1);
            let max_choices = max.unwrap_or(1);
            if max_choices < min {
                return Err(InvalidTree::SelectRange("a select's max is below its min"));
            }
            if max_choices as usize > options.len() {
                return Err(InvalidTree::SelectRange(
                    "a select's max is above the number of options",
                ));
            }
        }
        Component::TextInput { custom_id, label, min, max, value, .. } => {
            bound_custom_id(custom_id)?;
            bound("label", label, MAX_LABEL_CHARS)?;
            if let Some(v) = value {
                bound("value", v, MAX_TEXT_INPUT_VALUE_CHARS)?;
            }
            let min = min.unwrap_or(0) as usize;
            let max_len = max.unwrap_or(MAX_TEXT_INPUT_VALUE_CHARS as u32) as usize;
            if max_len < min || max_len > MAX_TEXT_INPUT_VALUE_CHARS {
                return Err(InvalidTree::SelectRange(
                    "a text_input's min/max are not a usable range",
                ));
            }
        }
    }
    Ok(())
}

fn bound_custom_id(id: &str) -> Result<(), InvalidTree> {
    if id.is_empty() {
        return Err(InvalidTree::CustomIdEmpty);
    }
    let len = id.chars().count();
    if len > MAX_CUSTOM_ID_CHARS {
        return Err(InvalidTree::CustomIdTooLong(len));
    }
    Ok(())
}

fn bound(field: &'static str, text: &str, max: usize) -> Result<(), InvalidTree> {
    if text.chars().count() > max {
        return Err(InvalidTree::TextTooLong { field, max });
    }
    Ok(())
}

/// `https:` only, no credentials: `javascript:`/`data:` are XSS and `user:pw@` lies about the host.
fn is_https(raw: &str) -> bool {
    match url::Url::parse(raw) {
        Ok(url) => {
            url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.host().is_some()
        }
        Err(_) => false,
    }
}

fn truncate_for_message(raw: &str) -> String {
    raw.chars().take(80).collect()
}

/// Images are resolved afterwards by the server, so a card whose image did not resolve is never stored.
pub fn validate_cards(cards: &[Card]) -> Result<(), InvalidTree> {
    if cards.len() > MAX_CARDS {
        return Err(InvalidTree::TooManyCards(cards.len()));
    }
    for card in cards {
        if let Some(title) = &card.title {
            bound("card title", title, MAX_CARD_TITLE_CHARS)?;
        }
        if let Some(description) = &card.description {
            bound("card description", description, MAX_CARD_DESCRIPTION_CHARS)?;
        }
        if let Some(url) = &card.url {
            if url.chars().count() > MAX_URL_CHARS || !is_https(url) {
                return Err(InvalidTree::CardUrlInvalid(truncate_for_message(url)));
            }
        }
        if let Some(colour) = card.colour {
            if colour > 0xff_ffff {
                return Err(InvalidTree::ColourOutOfRange(colour));
            }
        }
        if card.fields.len() > MAX_OPTIONS {
            return Err(InvalidTree::TooManyFields(card.fields.len()));
        }
        for field in &card.fields {
            bound("card field name", &field.name, MAX_CARD_FIELD_NAME_CHARS)?;
            bound("card field value", &field.value, MAX_CARD_FIELD_VALUE_CHARS)?;
        }
        if let Some(author) = &card.author {
            bound("card author name", &author.name, MAX_CARD_AUTHOR_CHARS)?;
        }
        if let Some(footer) = &card.footer {
            bound("card footer", &footer.text, MAX_CARD_FOOTER_CHARS)?;
        }
        let empty = card.title.is_none()
            && card.description.is_none()
            && card.fields.is_empty()
            && card.image.is_none()
            && card.thumbnail.is_none()
            && card.author.is_none()
            && card.footer.is_none();
        if empty {
            return Err(InvalidTree::EmptyCard);
        }
    }
    Ok(())
}

pub fn parse_components(value: &Value) -> Result<Vec<TopLevel>, String> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    serde_json::from_value(value.clone()).map_err(|e| e.to_string())
}

pub fn parse_cards(value: &Value) -> Result<Vec<Card>, String> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    serde_json::from_value(value.clone()).map_err(|e| e.to_string())
}

/// `None` for an absent id, a link button or a disabled component (a stale client must not press it).
pub fn find_pressable<'a>(rows: &'a [TopLevel], custom_id: &str) -> Option<&'a Component> {
    rows.iter()
        .flat_map(TopLevel::children)
        .find(|c| c.dispatching_custom_id() == Some(custom_id) && !c.is_disabled())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(components: Value) -> Value {
        json!({ "type": "action_row", "components": components })
    }

    fn button(custom_id: &str) -> Value {
        json!({ "type": "button", "style": "primary", "label": "go", "custom_id": custom_id })
    }

    fn parse(value: Value) -> Vec<TopLevel> {
        parse_components(&value).expect("parses")
    }

    #[test]
    fn a_plain_tree_round_trips_under_the_contract_names() {
        let tree = parse(json!([row(json!([
            button("a"),
            { "type": "button", "style": "link", "label": "docs", "url": "https://example.com/x" },
            { "type": "select", "custom_id": "s", "options": [{ "label": "One", "value": "1" }] }
        ]))]));
        validate_components(&tree, TreeContext::Message).expect("valid");
        let back = serde_json::to_value(&tree).unwrap();
        assert_eq!(back[0]["type"], "action_row");
        assert_eq!(back[0]["components"][0]["type"], "button");
        assert_eq!(back[0]["components"][0]["style"], "primary");
        assert_eq!(back[0]["components"][2]["type"], "select");
        assert!(back[0]["components"][0].get("url").is_none());
    }

    #[test]
    fn five_by_five_is_the_ceiling() {
        let five = json!([button("a"), button("b"), button("c"), button("d"), button("e")]);
        let ok: Vec<Value> = (0..5).map(|_| row(five.clone())).collect();
        let mut n = 0;
        let unique: Vec<Value> = ok
            .iter()
            .map(|r| {
                let kids: Vec<Value> = r["components"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|_| {
                        n += 1;
                        button(&format!("id{n}"))
                    })
                    .collect();
                row(json!(kids))
            })
            .collect();
        validate_components(&parse(json!(unique)), TreeContext::Message).expect("5x5 is legal");

        let six: Vec<Value> = (0..6).map(|i| row(json!([button(&format!("r{i}"))]))).collect();
        assert!(matches!(
            validate_components(&parse(json!(six)), TreeContext::Message),
            Err(InvalidTree::TooManyRows(6))
        ));

        let wide = json!([row(json!([
            button("a"), button("b"), button("c"), button("d"), button("e"), button("f")
        ]))]);
        assert!(matches!(
            validate_components(&parse(wide), TreeContext::Message),
            Err(InvalidTree::TooManyChildren(6))
        ));
    }

    #[test]
    fn custom_ids_are_bounded_and_unique_per_message() {
        let long = "x".repeat(MAX_CUSTOM_ID_CHARS + 1);
        assert!(matches!(
            validate_components(&parse(json!([row(json!([button(&long)]))])), TreeContext::Message),
            Err(InvalidTree::CustomIdTooLong(101))
        ));
        let dupe = json!([row(json!([button("same")])), row(json!([button("same")]))]);
        assert!(matches!(
            validate_components(&parse(dupe), TreeContext::Message),
            Err(InvalidTree::DuplicateCustomId(_))
        ));
    }

    #[test]
    fn link_buttons_are_url_xor_custom_id() {
        let both = json!([row(json!([{
            "type": "button", "style": "link", "label": "x",
            "url": "https://example.com", "custom_id": "no"
        }]))]);
        assert!(matches!(
            validate_components(&parse(both), TreeContext::Message),
            Err(InvalidTree::ButtonIdentity(_))
        ));

        let neither = json!([row(json!([{ "type": "button", "style": "link", "label": "x" }]))]);
        assert!(matches!(
            validate_components(&parse(neither), TreeContext::Message),
            Err(InvalidTree::ButtonIdentity(_))
        ));

        let scripted = json!([row(json!([{
            "type": "button", "style": "link", "label": "x", "url": "javascript:alert(1)"
        }]))]);
        assert!(matches!(
            validate_components(&parse(scripted), TreeContext::Message),
            Err(InvalidTree::LinkUrlInvalid(_))
        ));

        let primary_with_url = json!([row(json!([{
            "type": "button", "style": "primary", "label": "x",
            "custom_id": "a", "url": "https://example.com"
        }]))]);
        assert!(matches!(
            validate_components(&parse(primary_with_url), TreeContext::Message),
            Err(InvalidTree::ButtonIdentity(_))
        ));
    }

    #[test]
    fn selects_are_bounded() {
        let options: Vec<Value> =
            (0..26).map(|i| json!({ "label": format!("o{i}"), "value": i.to_string() })).collect();
        let too_many =
            json!([row(json!([{ "type": "select", "custom_id": "s", "options": options }]))]);
        assert!(matches!(
            validate_components(&parse(too_many), TreeContext::Message),
            Err(InvalidTree::TooManyOptions(26))
        ));

        let empty = json!([row(json!([{ "type": "select", "custom_id": "s", "options": [] }]))]);
        assert!(matches!(
            validate_components(&parse(empty), TreeContext::Message),
            Err(InvalidTree::NoOptions)
        ));

        let backwards = json!([row(json!([{
            "type": "select", "custom_id": "s", "min": 2, "max": 1,
            "options": [{ "label": "a", "value": "a" }, { "label": "b", "value": "b" }]
        }]))]);
        assert!(matches!(
            validate_components(&parse(backwards), TreeContext::Message),
            Err(InvalidTree::SelectRange(_))
        ));
    }

    #[test]
    fn text_inputs_belong_to_modals_only() {
        let in_message = json!([row(json!([{
            "type": "text_input", "custom_id": "t", "label": "Name", "style": "short"
        }]))]);
        assert!(matches!(
            validate_components(&parse(in_message.clone()), TreeContext::Message),
            Err(InvalidTree::WrongPlace(_))
        ));
        validate_components(&parse(in_message), TreeContext::Modal).expect("legal in a modal");

        let button_in_modal = json!([row(json!([button("a")]))]);
        assert!(matches!(
            validate_components(&parse(button_in_modal), TreeContext::Modal),
            Err(InvalidTree::WrongPlace(_))
        ));
    }

    #[test]
    fn a_link_button_is_never_pressable_and_neither_is_a_disabled_one() {
        let tree = parse(json!([row(json!([
            button("live"),
            { "type": "button", "style": "secondary", "label": "off", "custom_id": "dead", "disabled": true },
            { "type": "button", "style": "link", "label": "docs", "url": "https://example.com" }
        ]))]));
        assert!(find_pressable(&tree, "live").is_some());
        assert!(find_pressable(&tree, "dead").is_none());
        assert!(find_pressable(&tree, "missing").is_none());
    }

    #[test]
    fn cards_bound_their_fields_and_refuse_application_chosen_image_urls() {
        let card: Card = serde_json::from_value(json!({
            "title": "Deploy",
            "colour": 0x33ff66,
            "image": { "origin": "media.example", "hash": "abc" },
            "fields": [{ "name": "env", "value": "prod", "inline": true }]
        }))
        .unwrap();
        validate_cards(&[card]).expect("valid");

        let raw_url = serde_json::from_value::<Card>(json!({
            "title": "x", "image": "https://tracker.example/pixel.png"
        }));
        assert!(raw_url.is_err());

        let bad_colour: Card =
            serde_json::from_value(json!({ "title": "x", "colour": 0x1_000_000u32 })).unwrap();
        assert!(matches!(
            validate_cards(&[bad_colour]),
            Err(InvalidTree::ColourOutOfRange(_))
        ));

        let blank: Card = serde_json::from_value(json!({})).unwrap();
        assert!(matches!(validate_cards(&[blank]), Err(InvalidTree::EmptyCard)));
    }
}
