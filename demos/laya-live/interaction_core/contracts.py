"""Wire contracts. Model output stops at ActionIntent; numeric rules are server owned."""
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any, Protocol


class Degree(str, Enum):
    CRITICAL_FAILURE = "critical_failure"
    FAILURE = "failure"
    PARTIAL_SUCCESS = "partial_success"
    SUCCESS = "success"
    STRONG_SUCCESS = "strong_success"
    EXCEPTIONAL_SUCCESS = "exceptional_success"


KINDS = frozenset({"violence", "threat", "evidence_handover", "information_handover",
                   "cooperation", "apology", "hostility", "neutral", "question", "challenge"})
OPERATIONS = frozenset({"communicate", "persuade", "transfer", "unlock", "force",
                        "attack", "inspect", "assist"})


@dataclass(frozen=True)
class RelevantMemory:
    source: str
    content: str
    authority: str = "reference"


@dataclass(frozen=True)
class NarrativePressure:
    kind: str  # opportunity / threat / goal / hold / agenda
    target_id: str
    description: str
    tick: str = "scene"


@dataclass(frozen=True)
class TurnInput:
    session_id: str
    event_id: str
    actor_id: str
    message: str
    expected_versions: dict[str, str]


@dataclass(frozen=True)
class ActionIntent:
    id: str
    actor_id: str
    kind: str
    operation: str
    target_ids: tuple[str, ...]
    object_id: str | None
    tool_id: str | None
    mode: str  # attempt / negated / hypothetical / quoted
    content: str
    evidence: str
    tone: str
    depends_on: str | None = None  # execute only after this preceding action succeeds


@dataclass(frozen=True)
class TurnInterpretation:
    actions: tuple[ActionIntent, ...]
    ambiguities: tuple[str, ...] = ()


@dataclass(frozen=True)
class FactCheckResult:
    action_id: str
    allowed: bool
    reasons: tuple[str, ...]
    verified_evidence: tuple[str, ...] = ()


@dataclass(frozen=True)
class LayaEvidence:
    actor_id: str
    checkpoint: str
    rules_fingerprint: str
    signals: dict[str, Any]
    proposal: dict[str, Any]
    tendency: float = 0.0


@dataclass(frozen=True)
class ResolutionContext:
    action_id: str
    target_id: str | None
    factors: dict[str, float]
    margin: float | None
    rule: str


@dataclass(frozen=True)
class StateChange:
    entity_id: str
    path: str
    before: Any
    after: Any
    source: str


@dataclass(frozen=True)
class ActionResolution:
    action_id: str
    target_id: str | None
    degree: Degree
    achieved: str
    context: ResolutionContext
    check: FactCheckResult
    changes: tuple[StateChange, ...] = ()
    facts: tuple[dict, ...] = ()
    costs: tuple[str, ...] = ()
    complications: tuple[str, ...] = ()
    opportunities: tuple[str, ...] = ()


@dataclass(frozen=True)
class CanonicalOutcome:
    event_id: str
    result: str
    degree: Degree
    resolutions: tuple[ActionResolution, ...]
    facts_created: tuple[dict, ...]
    state_changes: tuple[StateChange, ...]
    costs: tuple[str, ...]
    complications: tuple[str, ...]
    opportunities: tuple[str, ...]


@dataclass(frozen=True)
class StateProposal:
    base_versions: dict[str, str]
    changes: tuple[StateChange, ...]


@dataclass(frozen=True)
class CommitResult:
    commit_id: str
    event_id: str
    versions: dict[str, str]
    outcome: CanonicalOutcome
    states: dict[str, dict]
    replayed: bool = False


@dataclass(frozen=True)
class SceneSnapshot:
    versions: dict[str, str]
    states: dict[str, dict]
    history: tuple[dict, ...] = ()


class Interpreter(Protocol):
    def interpret(self, turn: TurnInput, scene: SceneSnapshot) -> TurnInterpretation: ...


class EvidenceProvider(Protocol):
    def evaluate(self, turn: TurnInput, interpretation: TurnInterpretation,
                 scene: SceneSnapshot, targets: tuple[str, ...]) -> tuple[LayaEvidence, ...]: ...


class CoreError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code, self.status = code, status


def wire(value):
    """Dataclasses + str enums are directly JSON serializable after asdict."""
    return asdict(value)
