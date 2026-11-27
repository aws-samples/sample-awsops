// True while an IME (Korean/Japanese/Chinese) composition is in progress.
// Enter then confirms the composition and must not trigger submit/search actions.
// keyCode 229 covers browsers that fire the final keydown after compositionend.
export function isComposingKey(e: { nativeEvent?: { isComposing?: boolean }; keyCode?: number }): boolean {
  return e.nativeEvent?.isComposing === true || e.keyCode === 229;
}
