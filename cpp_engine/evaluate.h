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

// Bitboard utility
inline uint64_t file_mask(int f) {
    return 0x0101010101010101ULL << f;
}
inline int popcount(uint64_t b) {
    return (int)__popcnt64(b);
}
inline int bitscan(uint64_t b) {
    unsigned long idx;
    _BitScanForward64(&idx, b);
    return (int)idx;
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
