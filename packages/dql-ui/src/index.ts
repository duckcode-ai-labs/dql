// Public entry for @zlens/ui

// tokens
export {
  palette,
  space,
  radius,
  fontSize,
  fontWeight,
  lineHeight,
  font,
  z,
  darkTokens,
  lightTokens,
  themes,
  tokenToCssVar,
  themeToCssVars,
  cssVar,
  type ThemeTokens,
  type ThemeName,
} from './tokens/index.js';

// theme
export { ThemeProvider, useTheme, type ThemeProviderProps } from './theme/ThemeProvider.js';

// primitives
export { Tooltip, TooltipProvider, type TooltipProps } from './primitives/Tooltip.js';
export { Dialog, DialogClose, type DialogProps } from './primitives/Dialog.js';
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  type DropdownMenuContentProps,
} from './primitives/DropdownMenu.js';
export {
  Popover,
  PopoverTrigger,
  PopoverAnchor,
  PopoverContent,
  PopoverClose,
  type PopoverContentProps,
} from './primitives/Popover.js';

// PanelFrame primitive set (v1.3 Track 4)
export {
  PanelFrame,
  PanelSection,
  PanelCard,
  StatusPill,
  PanelEmpty,
  PanelToolbar,
  KeyValueGrid,
  type PanelFrameProps,
  type PanelSectionProps,
  type PanelCardProps,
  type StatusPillProps,
  type PanelEmptyProps,
  type PanelToolbarProps,
  type KeyValueGridProps,
  type KVItem,
} from './primitives/PanelFrame.js';

// Shell layout primitives (v1.3 Track 4)
export {
  Shell,
  TopBar,
  CanvasBody,
  LeftPanel,
  RightPanel,
  BottomDrawer,
  StatusBar,
  type ShellProps,
  type TopBarProps,
  type CanvasBodyProps,
  type StatusBarProps,
} from './primitives/Shell.js';

// SegmentedControl (v1.3 Track 4 — used by Studio/App toggle in Track 5)
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedControlOption,
} from './primitives/SegmentedControl.js';

// TrustBadge (v1.3 Track 4 — v1.4 plug slot)
export { TrustBadge, type TrustBadgeProps, type TrustState } from './primitives/TrustBadge.js';

// DerivationWalkPanel — consumer-facing "Why?" / show-your-work derivation panel
export {
  DerivationWalkPanel,
  type DerivationWalkPanelProps,
  type DerivationWalk,
  type DerivationStep,
  type DerivationStepKind,
} from './primitives/DerivationWalkPanel.js';

// CellChrome (v1.3 Track 6 — Hex-style cell card wrapper)
export { CellChrome, type CellChromeProps } from './primitives/CellChrome.js';

// PublishedCellChrome (v1.3 Track 11 — read-only card shared by App mode + dashboard emitter)
export { PublishedCellChrome, type PublishedCellChromeProps } from './primitives/PublishedCellChrome.js';

// Kbd (v1.3 Track 10 — keyboard shortcut chip)
export { Kbd, type KbdProps } from './primitives/Kbd.js';

