1. I don't really care about versioning - currently I operate in `beta` state, so preffer a perfect product than one that supports backwards compatibility and legacy.

2.  the counter solves a currently non existing problem. same with phase.
3. The seq should not be in the heapl format (if its just increasing - it is redundant). the `id` is not clear - where do we need it and where do we onlyneed `name`? if its redundant, we can also remove it. (I tend to say it is not needed and can be removed)
4. we can use the span without a thread for `global-span` - then we don't need the `phase` concept.
5. if `e` without a `b` - we can present it like the `b` happened before our trace started.
6. a span can be useful for analysis too - user created spans while analyzing.
7. I tend to think we need to switch from heap visualizer to analyzer. we need to think of the `address-view` as one view. and think of other views that can be relevant. same with the `temporal / sequential lane` as 2 kinds of bars, with more that may be available. 
8. I also think that dragging files is not scalable. it should feel more like a project, and an editor and the current way is not scalable. 