// Ported from Dark Reader v4.9.120 (https://github.com/darkreader/darkreader,
// tag v4.9.120, commit 90c39130c7b4c79068f26aaa596071c14e3425c4):
// src/utils/math-eval.ts.
// Copyright (c) 2026 Dark Reader Ltd. MIT License; see
// public/licenses/rust/darkreader-mit.txt.
use super::color::js_parse_float;
use std::collections::VecDeque;

fn precedence(op: &str) -> Option<u8> {
    match op {
        "+" | "-" => Some(1),
        "*" | "/" => Some(2),
        _ => None,
    }
}

fn exec(op: &str, left: f64, right: f64) -> f64 {
    match op {
        "+" => left + right,
        "-" => left - right,
        "*" => left * right,
        _ => left / right,
    }
}

/// `evalMath`: shunting-yard to RPN, then evaluate. Statement-for-statement,
/// including DR's front-of-stack (`shift`/`unshift`/`splice(0, 2)`) handling.
pub fn eval_math(expression: &str) -> f64 {
    let mut rpn: Vec<String> = Vec::new();
    let mut working: VecDeque<String> = VecDeque::new();
    let mut last: Option<String> = None;
    for ch in expression.chars() {
        let token = ch.to_string();
        if token == " " {
            continue;
        }
        if let Some(p) = precedence(&token) {
            while let Some(front) = working.front() {
                let Some(cur) = precedence(front) else { break };
                if p <= cur {
                    rpn.push(working.pop_front().unwrap());
                } else {
                    break;
                }
            }
            working.push_front(token.clone());
        } else if last.as_deref().map_or(true, |l| precedence(l).is_some()) {
            rpn.push(token.clone());
        } else {
            rpn.last_mut().unwrap().push_str(&token);
        }
        last = Some(token);
    }
    rpn.extend(working);
    let mut stack: VecDeque<f64> = VecDeque::new();
    for t in &rpn {
        if precedence(t).is_some() {
            let a0 = stack.pop_front().unwrap_or(f64::NAN);
            let a1 = stack.pop_front().unwrap_or(f64::NAN);
            stack.push_back(exec(t, a1, a0));
        } else {
            stack.push_front(js_parse_float(t));
        }
    }
    stack.front().copied().unwrap_or(f64::NAN)
}
