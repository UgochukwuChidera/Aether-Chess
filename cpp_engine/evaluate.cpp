#include "evaluate.h"
#include <cstdlib>
#include <cctype>

// PST tables from mentor_engine.py
static const int PAWN_TABLE[64] = {
    0,0,0,0,0,0,0,0,
    5,5,5,-10,-10,5,5,5,
    5,10,20,25,25,20,10,5,
    5,15,25,30,30,25,15,5,
    5,15,25,35,35,25,15,5,
    5,10,20,25,25,20,10,5,
    5,5,10,15,15,10,5,5,
    10,10,10,10,10,10,10,10,
};
static const int KNIGHT_TABLE[64] = {
    -50,-40,-30,-20,-20,-30,-40,-50,
    -40,-20,10,15,15,10,-20,-40,
    -30,10,20,25,25,20,10,-30,
    -25,15,25,30,30,25,15,-25,
    -25,15,25,30,30,25,15,-25,
    -30,10,20,25,25,20,10,-30,
    -40,-20,10,15,15,10,-20,-40,
    -50,-40,-30,-20,-20,-30,-40,-50,
};
static const int BISHOP_TABLE[64] = {
    -20,-10,-10,-5,-5,-10,-10,-20,
    -10,0,0,0,0,0,0,-10,
    -10,0,5,10,10,5,0,-10,
    -10,5,10,15,15,10,5,-10,
    -10,0,10,15,15,10,0,-10,
    -10,0,5,10,10,5,0,-10,
    -20,-10,0,5,5,0,-10,-20,
    -20,-10,-10,-5,-5,-10,-10,-20,
};
static const int ROOK_TABLE[64] = {
    50,50,50,50,50,50,50,50,
    40,40,40,40,40,40,40,40,
    30,30,30,30,30,30,30,30,
    20,20,20,20,20,20,20,20,
    10,10,10,10,10,10,10,10,
    5,5,10,15,15,10,5,5,
    0,0,5,10,10,5,0,0,
    0,0,0,5,5,0,0,0,
};
static const int QUEEN_TABLE[64] = {
    -20,-10,-10,-5,-5,-10,-10,-20,
    -10,0,5,5,5,5,0,-10,
    -10,5,5,10,10,5,5,-10,
    -5,5,10,10,10,10,5,-5,
    0,5,10,10,10,10,5,-5,
    -10,5,5,5,5,5,0,-10,
    -10,0,0,0,0,0,0,-10,
    -20,-10,-10,-5,-5,-10,-10,-20,
};
static const int KING_MID[64] = {
    20,30,10,0,0,10,30,20,
    20,20,0,0,0,0,20,20,
   -10,-20,-20,-20,-20,-20,-20,-10,
   -20,-30,-30,-40,-40,-30,-30,-20,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
};
static const int KING_END[64] = {
   -50,-30,-30,-30,-30,-30,-30,-50,
   -30,-20,0,5,5,0,-20,-30,
   -30,5,20,30,30,20,5,-30,
   -30,5,30,40,40,30,5,-30,
   -30,5,30,40,40,30,5,-30,
   -30,5,20,30,30,20,5,-30,
   -30,-20,0,0,0,0,-20,-30,
   -50,-30,-30,-30,-30,-30,-30,-50,
};

static const int* PST[6] = {PAWN_TABLE, KNIGHT_TABLE, BISHOP_TABLE, ROOK_TABLE, QUEEN_TABLE, KING_MID};
static const int PIECE_VALUES[6] = {100, 350, 350, 550, 950, 20000};

void BoardState::clear() {
    for (int i = 0; i < 6; i++)
        pieces[i][0] = pieces[i][1] = 0;
    all_pieces = 0;
    turn = 0;
    king_sq[0] = king_sq[1] = -1;
}

bool BoardState::parse_fen(const char* fen) {
    clear();
    const char* p = fen;
    int sq = 0;
    
    while (*p && *p != ' ') {
        if (*p == '/') { p++; continue; }
        if (isdigit(*p)) { sq += (*p - '0'); p++; continue; }
        int c = isupper(*p) ? WHITE : BLACK;
        char lower = tolower(*p);
        int pt;
        switch (lower) {
            case 'p': pt = PAWN; break;
            case 'n': pt = KNIGHT; break;
            case 'b': pt = BISHOP; break;
            case 'r': pt = ROOK; break;
            case 'q': pt = QUEEN; break;
            case 'k': pt = KING; king_sq[c] = sq; break;
            default: return false;
        }
        pieces[pt][c] |= (1ULL << sq);
        sq++;
        p++;
    }
    if (*p++ != ' ') return false;
    turn = (*p == 'w') ? WHITE : BLACK;
    
    // Compute all_pieces
    all_pieces = 0;
    for (int i = 0; i < 6; i++)
        all_pieces |= pieces[i][0] | pieces[i][1];
    
    if (king_sq[WHITE] < 0 || king_sq[BLACK] < 0) return false;
    return true;
}

static int phase_from_board(const BoardState& board, int& mg_score, int& eg_score) {
    int total = 0;
    for (int c = 0; c <= 1; c++) {
        int sign = (c == WHITE) ? 1 : -1;
        for (int pt = PAWN; pt <= QUEEN; pt++) {
            uint64_t bb = board.pieces[pt][c];
            const int* pst = PST[pt];
            int val = PIECE_VALUES[pt];
            while (bb) {
                int sq = bitscan(bb);
                bb &= bb - 1;
                total++;
                int idx = (c == WHITE) ? sq : MIRROR(sq);
                mg_score += sign * (val + pst[idx]);
                eg_score += sign * (val + KING_END[idx]);
            }
        }
    }
    int ph = 256 - total * 16;
    if (ph < 0) ph = 0;
    if (ph > 256) ph = 256;
    return ph;
}

int evaluate(const BoardState& board) {
    if (popcount(board.pieces[KING][WHITE]) == 0) return -100000;
    if (popcount(board.pieces[KING][BLACK]) == 0) return 100000;

    int mg_score = 0;
    int eg_score = 0;
    int phase = phase_from_board(board, mg_score, eg_score);

    // Kings
    if (board.king_sq[WHITE] >= 0) {
        mg_score += KING_MID[board.king_sq[WHITE]];
        eg_score += KING_END[board.king_sq[WHITE]];
    }
    if (board.king_sq[BLACK] >= 0) {
        mg_score -= KING_MID[MIRROR(board.king_sq[BLACK])];
        eg_score -= KING_END[MIRROR(board.king_sq[BLACK])];
    }

    int score = (mg_score * (256 - phase) + eg_score * phase) / 256;

    // Pawn structure
    for (int c = 0; c <= 1; c++) {
        uint64_t pawns = board.pieces[PAWN][c];
        int sign = (c == WHITE) ? 1 : -1;
        int file_counts[8] = {0};
        uint64_t tmp = pawns;
        while (tmp) {
            int sq = bitscan(tmp);
            tmp &= tmp - 1;
            file_counts[FILE(sq)]++;
        }
        tmp = pawns;
        while (tmp) {
            int sq = bitscan(tmp);
            tmp &= tmp - 1;
            int f = FILE(sq);
            if ((f == 0 || file_counts[f-1] == 0) && (f == 7 || file_counts[f+1] == 0))
                score -= sign * 15;
            if (file_counts[f] > 1)
                score -= sign * 10;
        }
    }

    // Bishop pair
    if (popcount(board.pieces[BISHOP][WHITE]) >= 2) score += 50;
    if (popcount(board.pieces[BISHOP][BLACK]) >= 2) score -= 50;

    // Rook evaluation
    for (int c = 0; c <= 1; c++) {
        uint64_t rooks = board.pieces[ROOK][c];
        uint64_t w_pawns = board.pieces[PAWN][WHITE];
        uint64_t b_pawns = board.pieces[PAWN][BLACK];
        int sign = (c == WHITE) ? 1 : -1;
        while (rooks) {
            int sq = bitscan(rooks);
            rooks &= rooks - 1;
            int f = FILE(sq), r = RANK(sq);
            int bonus = 0;
            bool w_has = (file_mask(f) & w_pawns) != 0;
            bool b_has = (file_mask(f) & b_pawns) != 0;
            if (!w_has && !b_has) bonus += 70;
            else if ((c == WHITE && !w_has && b_has) || (c == BLACK && !b_has && w_has))
                bonus += 35;
            if (c == WHITE && r == 6) bonus += 50;
            if (c == BLACK && r == 1) bonus += 50;
            // Blocked rook penalty
            uint64_t fp = (c == WHITE ? w_pawns : b_pawns) & file_mask(f);
            while (fp) {
                int ps = bitscan(fp);
                fp &= fp - 1;
                if ((c == WHITE && RANK(ps) > r) || (c == BLACK && RANK(ps) < r)) {
                    bonus -= 40;
                    break;
                }
            }
            score += sign * bonus;
        }
    }

    return (board.turn == WHITE) ? score : -score;
}

int evaluate_fen(const char* fen) {
    BoardState board;
    if (!board.parse_fen(fen)) return 0;
    return evaluate(board);
}
