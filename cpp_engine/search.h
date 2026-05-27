#ifndef SEARCH_H
#define SEARCH_H

#include "evaluate.h"

// Transposition Table entry
struct TTEntry {
    uint64_t key;
    int depth;
    int value;
    int flag;    // 0=EXACT, 1=LOWER, 2=UPPER
    int best_move_sq; // packed: (from << 6) | to
    uint16_t padding;
};

const int TT_SIZE = 1 << 20; // 1M entries
const int INF = 1000000000;

struct SearchResult {
    int score;
    int best_move_from;
    int best_move_to;
};

class Searcher {
public:
    Searcher();
    ~Searcher();
    
    SearchResult search(const BoardState& board, int max_depth, int max_nodes, double time_limit);

private:
    TTEntry* tt;
    uint64_t tt_mask;
    uint64_t nodes;
    double start_time;
    double time_limit;
    int max_nodes;
    bool stop_flag;
    
    void clear_tt();
    void store_tt(uint64_t key, int depth, int value, int flag, int move_sq);
    bool probe_tt(uint64_t key, int depth, int& value, int& move_sq, int alpha, int beta);
    bool out_of_time();
    
    int negamax(BoardState& board, int depth, int ply, int alpha, int beta, bool allow_null);
    int quiescence(BoardState& board, int alpha, int beta, int depth);
    
    void generate_moves(const BoardState& board, int* moves, int& count);
    void score_moves(const BoardState& board, int* moves, int count, int* scores, int tt_move_sq);
    void make_move(BoardState& board, int move_sq);
    void unmake_move(BoardState& board, int move_sq);
    bool is_move_legal(const BoardState& board, int move_sq);
};

#endif
