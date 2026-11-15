from enum import IntEnum


class DataClass(IntEnum):
    """Ordered data classes (design 0001 §3). Comparison follows sensitivity."""

    C0 = 0
    C1 = 1
    C2 = 2
    C3 = 3

    @classmethod
    def parse(cls, value: str | None) -> "DataClass":
        """Unknown or missing classes are treated as C3 (fail closed)."""
        try:
            return cls[value] if value else cls.C3
        except KeyError:
            return cls.C3
