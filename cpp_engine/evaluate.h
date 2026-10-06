#ifndef EVALUATE_H
#define EVALUATE_H

#include <cstdint>
#include <string>

#define FILE(sq) ((sq) & 7)
#define RANK(sq) ((sq) >> 3)
#define MIRROR(sq) ((sq) ^ 56)

#define WHITE 0
#define BLACK 1

enum PieceType {
    PAWN=0, KNIGHT=1, BISHOP=2, ROOK=3, QUEEN=4, KING=5, NONE=6
};

#ifdef _MSC_VER
#include <intrin.h>
#endif

// Bitboard utility
inline uint64_t file_mask(int f) {
    return 0x0101010101010101ULL << f;
}
// P4-T03 Tier 0 (§2c shim): __popcnt64 / _BitScanForward64 are MSVC-only.
// MSVC keeps its intrinsics; every other compiler gets the __builtin_*
// equivalents. All call sites guarantee b != 0 (while(bb) loops), so the
// ctz-on-zero UB matches _BitScanForward64's undefined-on-zero exactly.
inline int popcount(uint64_t b) {
#if defined(_MSC_VER)
    return (int)__popcnt64(b);
#else
    return (int)__builtin_popcountll(b);
#endif
}
inline int bitscan(uint64_t b) {
#if defined(_MSC_VER)
    unsigned long idx;
    _BitScanForward64(&idx, b);
    return (int)idx;
#else
    return (int)__builtin_ctzll(b);
#endif
}

struct BoardState {
    uint64_t pieces[6][2];
    uint64_t all_pieces;
    int turn;
    int king_sq[2];
    
    void clear();
    bool parse_fen(const char* fen);
};

int evaluate(const BoardState& board);
int evaluate_fen(const char* fen);

#endif
