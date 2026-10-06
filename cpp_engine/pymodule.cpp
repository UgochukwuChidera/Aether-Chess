#include <Python.h>
#include "evaluate.h"

// Python wrapper for evaluate_fen(const char* fen) -> int
static PyObject* evaluate_fen_wrapper(PyObject* self, PyObject* args) {
    const char* fen;
    if (!PyArg_ParseTuple(args, "s", &fen))
        return NULL;
    int result = evaluate_fen(fen);
    return PyLong_FromLong(result);
}

// Python wrapper: evaluate_batch(fen_list) -> [score, ...]
static PyObject* evaluate_batch_wrapper(PyObject* self, PyObject* args) {
    PyObject* fen_list;
    if (!PyArg_ParseTuple(args, "O", &fen_list))
        return NULL;
    if (!PyList_Check(fen_list))
        return NULL;
    
    Py_ssize_t n = PyList_Size(fen_list);
    PyObject* result = PyList_New(n);
    if (!result) return NULL;
    
    for (Py_ssize_t i = 0; i < n; i++) {
        PyObject* item = PyList_GetItem(fen_list, i);
        const char* fen = PyUnicode_AsUTF8(item);
        if (!fen) {
            Py_DECREF(result);
            return NULL;
        }
        int score = evaluate_fen(fen);
        PyList_SetItem(result, i, PyLong_FromLong(score));
    }
    return result;
}

static PyMethodDef CppEngineMethods[] = {
    {"evaluate",  evaluate_fen_wrapper,  METH_VARARGS,
     "Evaluate a chess position from FEN string. Returns centipawn score."},
    {"evaluate_batch",  evaluate_batch_wrapper,  METH_VARARGS,
     "Evaluate multiple FEN positions. Returns list of scores."},
    {NULL, NULL, 0, NULL}
};

static struct PyModuleDef cpp_engine_module = {
    PyModuleDef_HEAD_INIT,
    "cpp_engine",
    "Fast C++ chess evaluation for AetherChess",
    -1,
    CppEngineMethods
};

PyMODINIT_FUNC PyInit_cpp_engine(void) {
    return PyModule_Create(&cpp_engine_module);
}
