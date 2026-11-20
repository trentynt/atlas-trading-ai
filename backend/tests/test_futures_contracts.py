"""Phase 1: MNQ contract and exact dollar costs."""
import pytest

from atlas.futures.contracts import MNQ, FuturesCosts, fill_price, round_turn, whole_contracts


def test_mnq_spec():
    assert MNQ.multiplier == 2.0 and MNQ.tick_size == 0.25 and MNQ.tick_value == 0.50
    assert MNQ.round_to_tick(18000.13) == 18000.25
    assert MNQ.round_to_tick(18000.12) == 18000.0


def test_known_long_round_turn_exact_dollars():
    # Buy 2 MNQ at 18,000.00, sell at 18,010.00; $0.62/side commission, 1 tick slippage per side.
    # Fills: buy 18,000.25, sell 18,009.75 → 9.50 points × $2 × 2 contracts = $38.00 gross
    # Commission: 0.62 × 2 sides × 2 contracts = $2.48 → net $35.52
    rt = round_turn(MNQ, +1, 2, 18000.00, 18010.00, FuturesCosts(0.62, 1))
    assert rt.points == 9.5 and rt.gross == 38.00 and rt.commission == 2.48 and rt.net == 35.52
    assert rt.slippage == 2.00  # 1 tick × $0.50 × 2 sides × 2 contracts


def test_known_short_round_turn_exact_dollars():
    # Short 1 at 18,000, cover at 17,980: fills 17,999.75 / 17,980.25 → 19.5 pts = $39.00; commission $1.24
    rt = round_turn(MNQ, -1, 1, 18000.00, 17980.00, FuturesCosts(0.62, 1))
    assert rt.gross == 39.00 and rt.net == 37.76


def test_flat_trade_loses_exactly_the_costs():
    rt = round_turn(MNQ, +1, 3, 18000, 18000, FuturesCosts(0.62, 1))
    assert rt.net == -6.72  # = -(3.00 + 3.72): 2 ticks × $0.50 × 3 slippage + 0.62 × 2 × 3 commission


def test_zero_costs_is_pure_points():
    assert round_turn(MNQ, +1, 1, 18000, 18001, FuturesCosts(0, 0)).net == 2.00


def test_whole_contracts_only():
    assert whole_contracts(3) == 3 and whole_contracts(2.0) == 2
    for bad in (1.5, 0.1, True):
        with pytest.raises(ValueError):
            whole_contracts(bad)
    with pytest.raises(ValueError):
        round_turn(MNQ, +1, 0.5, 18000, 18010, FuturesCosts())


def test_slippage_always_against_you():
    c = FuturesCosts(0, 2)
    assert fill_price(MNQ, +1, 18000, c) == 18000.5 and fill_price(MNQ, -1, 18000, c) == 17999.5
