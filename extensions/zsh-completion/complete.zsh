# Sourced in an interactive Zsh under ZLE, never evaluate the requested buffer.
(( $+functions[compdef] )) || { autoload -Uz compinit; compinit -i; }

_pi_complete_widget() {
  local _pi_fd
  exec {_pi_fd}>"$PI_ZSH_RESULT"
  # Capture matches produced by the user's normal compsys functions. Keep the
  # original compadd behavior so completion functions can inspect nmatches.
  functions[_pi_saved_compadd]=${functions[compadd]-}
  compadd() {
    local -a _pi_matches
    local _pi_match _pi_left _pi_right _pi_arg
    # Completion functions use compadd to query/filter arrays internally; those
    # are not user-facing candidates and may not yet be escaped or prefixed.
    for _pi_arg in "$@"; do
      [[ $_pi_arg == -- ]] && break
      if [[ $_pi_arg == -[AOD]* ]]; then
        builtin compadd "$@"
        return
      fi
    done
    builtin compadd -O _pi_matches "$@"
    local -a _pi_p _pi_P _pi_s _pi_S
    zparseopts -E p:=_pi_p P:=_pi_P s:=_pi_s S:=_pi_S
    _pi_left=${LBUFFER[1,$(( ${#LBUFFER} - ${#PREFIX} ))]}
    _pi_right=${RBUFFER[$(( ${#SUFFIX} + 1 )),-1]}
    for _pi_match in "${_pi_matches[@]}"; do
      print -rN -u $_pi_fd -- "${_pi_left}${IPREFIX}${_pi_P[2]}${_pi_p[2]}${_pi_match}${_pi_s[2]}${_pi_S[2]}${ISUFFIX}${_pi_right}"
    done
    builtin compadd "$@"
  }
  unset 'compstate[vared]'
  _main_complete
  print -rN -u $_pi_fd -- '__PI_ZSH_DONE__'
  exec {_pi_fd}>&-
  if [[ -n $functions[_pi_saved_compadd] ]]; then
    functions[compadd]=$functions[_pi_saved_compadd]
  else
    unfunction compadd
  fi
}
zle -C _pi_complete complete-word _pi_complete_widget
bindkey '^X^Z' _pi_complete
