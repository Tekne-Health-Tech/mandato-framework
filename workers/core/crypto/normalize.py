"""Normalization v1 for blind indexes (design 0001 §4.6). Must match packages/crypto/src/normalize.js."""
import re
import unicodedata


class NormalizeError(ValueError):
    pass


def email(value: str) -> str:
    s = value.strip()
    at = s.find("@")
    if at <= 0 or at != s.rfind("@") or at == len(s) - 1:
        raise NormalizeError("invalid")
    local = unicodedata.normalize("NFKC", s[:at]).lower()
    domain = unicodedata.normalize("NFKC", s[at + 1:]).lower()
    if not re.fullmatch(r"[\x21-\x7e]+", domain):
        raise NormalizeError("non-ascii-domain")
    return f"{local}@{domain}"


def phone(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if value.strip().startswith("+") and 8 <= len(digits) <= 15:
        return f"+{digits}"
    if len(digits) in (10, 11):
        return f"+55{digits}"
    if len(digits) in (12, 13) and digits.startswith("55"):
        return f"+{digits}"
    raise NormalizeError("invalid")
