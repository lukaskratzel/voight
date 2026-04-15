cmake_minimum_required(VERSION 3.14)
project(voight_parser LANGUAGES CXX)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_program(CCACHE_PROGRAM ccache)
if(CCACHE_PROGRAM)
    set(CMAKE_C_COMPILER_LAUNCHER ${CCACHE_PROGRAM})
    set(CMAKE_CXX_COMPILER_LAUNCHER ${CCACHE_PROGRAM})
endif()

include(FetchContent)

if(DEFINED ENV{VOIGHT_FETCHCONTENT_BASE_DIR})
    set(FETCHCONTENT_BASE_DIR "$ENV{VOIGHT_FETCHCONTENT_BASE_DIR}" CACHE PATH "" FORCE)
endif()

FetchContent_Declare(
    antlr4
    GIT_REPOSITORY https://github.com/antlr/antlr4.git
    GIT_TAG 4.13.2
    EXCLUDE_FROM_ALL
    SOURCE_SUBDIR runtime/Cpp
)

set(ANTLR_BUILD_CPP_TESTS OFF CACHE BOOL "" FORCE)
set(ANTLR_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(ANTLR4_WITH_STATIC_CRT OFF CACHE BOOL "" FORCE)
set(ANTLR4_INSTALL OFF CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(antlr4)

set(ANTLR_INCLUDE_DIR ${antlr4_SOURCE_DIR}/runtime/Cpp/runtime/src/)

set(PARSER_SOURCES
    generated/VoightLexer.cpp
    generated/VoightParser.cpp
    generated/VoightParserBaseVisitor.cpp
    generated/VoightParserVisitor.cpp
    error.cpp
    json.cpp
    parser_json.cpp
)

add_library(voight_parser_core ${PARSER_SOURCES})

target_include_directories(
    voight_parser_core
    PRIVATE ${ANTLR_INCLUDE_DIR}
    PRIVATE ${PROJECT_SOURCE_DIR}
)

target_link_libraries(voight_parser_core PRIVATE antlr4_static)

add_executable(voight_parser_cli parser_cli.cpp)
target_include_directories(voight_parser_cli PRIVATE ${ANTLR_INCLUDE_DIR} ${PROJECT_SOURCE_DIR})
target_link_libraries(voight_parser_cli PRIVATE voight_parser_core antlr4_static)

if(EMSCRIPTEN)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fwasm-exceptions")
    add_executable(voight_parser_wasm parser_wasm.cpp)
    target_include_directories(voight_parser_wasm PRIVATE ${ANTLR_INCLUDE_DIR} ${PROJECT_SOURCE_DIR})
    target_link_libraries(voight_parser_wasm PRIVATE voight_parser_core antlr4_static)

    set(CMAKE_EXECUTABLE_SUFFIX ".js")
    set_target_properties(voight_parser_wasm PROPERTIES
        LINK_FLAGS "\
            -lembind \
            -s WASM=1 \
            -s MODULARIZE=1 \
            -s EXPORT_ES6=1 \
            -s EXPORT_NAME='createVoightParser' \
            -s ALLOW_MEMORY_GROWTH=1 \
            -s SINGLE_FILE=1 \
            -s STACK_SIZE=1048576 \
        "
    )

    if(DEFINED ENV{VOIGHT_PARSER_PACKAGE_DIR})
        set(CMAKE_INSTALL_PREFIX $ENV{VOIGHT_PARSER_PACKAGE_DIR} CACHE PATH "" FORCE)
    else()
        set(CMAKE_INSTALL_PREFIX ${PROJECT_SOURCE_DIR}/../../packages/voight-parser CACHE PATH "" FORCE)
    endif()
    install(TARGETS voight_parser_wasm RUNTIME DESTINATION dist)
endif()
